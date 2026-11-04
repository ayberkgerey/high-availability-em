/* PeopleDesk – frontend application (vanilla JS, no build step). */
(() => {
  'use strict';

  // All API paths are relative so the app works identically behind any ALB DNS name or instance.
  const API = {
    dashboard: '/api/dashboard',
    employees: '/api/employees',
    exportCsv: '/api/employees/export',
    departments: '/api/departments',
    instance: '/api/instance',
    health: '/health',
    ready: '/ready',
  };

  const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract'];
  const STATUSES = ['Active', 'On Leave', 'Inactive'];
  const READY_POLL_MS = 30000;
  const LB_TEST_REQUESTS = 20;

  const AVATAR_PALETTE = [
    ['#eef2ff', '#4338ca'], ['#f5f3ff', '#6d28d9'], ['#ecfdf3', '#047857'], ['#fff7ed', '#c2410c'],
    ['#fdf2f8', '#be185d'], ['#ecfeff', '#0e7490'], ['#fefce8', '#a16207'], ['#f0f9ff', '#0369a1'],
  ];
  const DEPT_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#ef4444', '#14b8a6', '#a855f7'];

  const state = {
    route: 'dashboard',
    departments: [],
    employees: [],
    pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
    query: { search: '', department: '', status: '', sortBy: 'name', sortOrder: 'asc', page: 1, pageSize: 10 },
    listRequestSeq: 0,
    editingId: null,
    detailEmployee: null,
    deleteTarget: null,
    lastFocused: null,
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, extraClass = '') {
    return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function hashString(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash;
  }

  function initials(firstName, lastName) {
    return `${(firstName || '').charAt(0)}${(lastName || '').charAt(0)}`.toUpperCase() || '?';
  }

  function avatar(firstName, lastName, size = '') {
    const [bg, fg] = AVATAR_PALETTE[hashString(`${firstName} ${lastName}`) % AVATAR_PALETTE.length];
    return `<div class="avatar ${size}" style="--avatar-bg:${bg};--avatar-fg:${fg}" aria-hidden="true">${escapeHtml(initials(firstName, lastName))}</div>`;
  }

  function deptColor(name) {
    const index = state.departments.findIndex((d) => d.name === name);
    return DEPT_COLORS[(index >= 0 ? index : hashString(name || '')) % DEPT_COLORS.length];
  }

  function parseIsoDate(value) {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateTimeFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const numberFormatter = new Intl.NumberFormat('en-US');

  const formatDate = (value) => (value ? dateFormatter.format(parseIsoDate(value)) : '—');
  const formatDateTime = (value) => (value ? dateTimeFormatter.format(new Date(value)) : '—');

  function todayIso() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function statusBadge(status) {
    const cls = { Active: 'badge--active', 'On Leave': 'badge--leave', Inactive: 'badge--inactive' }[status] || 'badge--inactive';
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    const spinner = $('.spinner', button);
    if (spinner) spinner.hidden = !loading;
  }

  // ---------------------------------------------------------------------------
  // API client
  // ---------------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, status, code, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function request(path, { method = 'GET', body, timeoutMs = 15000, raw = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(path, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      const message = err.name === 'AbortError'
        ? 'The request timed out. Please try again.'
        : 'Unable to reach the server. Please check your connection.';
      throw new ApiError(message, 0, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }

    if (raw && response.ok) return response;
    if (response.status === 204) return null;

    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      const error = payload && payload.error;
      const fallback = response.status >= 500
        ? 'The service is temporarily unavailable. Please try again shortly.'
        : `Request failed (HTTP ${response.status})`;
      throw new ApiError(error?.message || fallback, response.status, error?.code, error?.details);
    }
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  function showToast(type, title, message = '') {
    const container = $('#toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `
      <span class="toast__icon">${icon(type === 'error' ? 'alert' : 'check-circle')}</span>
      <div class="toast__body">
        <div class="toast__title">${escapeHtml(title)}</div>
        ${message ? `<div class="toast__message">${escapeHtml(message)}</div>` : ''}
      </div>
      <button class="icon-btn" aria-label="Dismiss">${icon('x', 'icon--sm')}</button>`;

    const dismiss = () => {
      if (toast.classList.contains('is-leaving')) return;
      toast.classList.add('is-leaving');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };
    $('button', toast).addEventListener('click', dismiss);
    container.appendChild(toast);
    setTimeout(dismiss, type === 'error' ? 6500 : 4000);
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------
  function openModal(modal) {
    state.lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const focusTarget = $('input:not([type=hidden]), select, button:not([data-close-modal])', modal) || $('button', modal);
    if (focusTarget) setTimeout(() => focusTarget.focus(), 50);
  }

  function closeModal(modal) {
    if (modal.hidden) return;
    modal.hidden = true;
    if ($$('.modal').every((m) => m.hidden)) document.body.style.overflow = '';
    if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
  }

  function topmostOpenModal() {
    return $$('.modal').reverse().find((m) => !m.hidden);
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------
  const ROUTES = ['dashboard', 'departments', 'system'];

  function currentRoute() {
    const route = window.location.hash.replace(/^#\/?/, '');
    return ROUTES.includes(route) ? route : 'dashboard';
  }

  function handleRoute() {
    state.route = currentRoute();
    $$('.view').forEach((view) => { view.hidden = view.dataset.view !== state.route; });
    $$('.nav-link').forEach((link) => link.classList.toggle('is-active', link.dataset.route === state.route));
    closeSidebar();
    window.scrollTo({ top: 0 });

    if (state.route === 'dashboard') {
      loadDashboard();
      loadEmployees();
    } else if (state.route === 'departments') {
      loadDepartmentsView();
    } else if (state.route === 'system') {
      loadSystemView();
    }
  }

  function navigate(route) {
    if (currentRoute() === route && window.location.hash) handleRoute();
    else window.location.hash = `#/${route}`;
  }

  function openSidebar() { $('#sidebar').classList.add('is-open'); }
  function closeSidebar() { $('#sidebar').classList.remove('is-open'); }

  // ---------------------------------------------------------------------------
  // Departments (shared lookup)
  // ---------------------------------------------------------------------------
  async function loadDepartments() {
    try {
      const { data } = await request(API.departments);
      state.departments = data;
      renderDepartmentOptions();
    } catch (err) {
      showToast('error', 'Could not load departments', err.message);
    }
  }

  function renderDepartmentOptions() {
    const filter = $('#departmentFilter');
    const selected = state.query.department;
    filter.innerHTML = '<option value="">All departments</option>' + state.departments
      .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`)
      .join('');
    filter.value = selected;

    $('#department').innerHTML = '<option value="">Select department</option>' + state.departments
      .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`)
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  async function loadDashboard() {
    try {
      const { data } = await request(API.dashboard);
      renderStats(data);
      renderBreakdown(data.departmentBreakdown);
      renderRecentHires(data.recentHires);
    } catch (err) {
      $$('[data-stat]').forEach((el) => { el.textContent = '—'; });
      $('#departmentBreakdown').innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
      $('#recentHires').innerHTML = '';
    }
  }

  function renderStats(stats) {
    $$('[data-stat]').forEach((el) => {
      el.textContent = numberFormatter.format(stats[el.dataset.stat] ?? 0);
    });
    const ratio = stats.totalEmployees ? Math.round((stats.activeEmployees / stats.totalEmployees) * 100) : 0;
    $('[data-stat-hint="activeEmployees"]').innerHTML = `<strong>${ratio}%</strong> of workforce`;
  }

  function renderBreakdown(rows) {
    const container = $('#departmentBreakdown');
    if (!rows.length) {
      container.innerHTML = '<p class="muted">No departments yet.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.headcount));
    container.innerHTML = rows.map((row) => `
      <div class="bar-row">
        <div class="bar-row__head">
          <span class="bar-row__label">${escapeHtml(row.department)}</span>
          <span class="bar-row__value">${row.headcount}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:0%" data-width="${(row.headcount / max) * 100}"></div></div>
      </div>`).join('');
    requestAnimationFrame(() => {
      $$('.bar-fill', container).forEach((bar) => { bar.style.width = `${bar.dataset.width}%`; });
    });
  }

  function renderRecentHires(rows) {
    const list = $('#recentHires');
    if (!rows.length) {
      list.innerHTML = '<li class="muted">No employees yet.</li>';
      return;
    }
    list.innerHTML = rows.map((row) => {
      const [first, ...rest] = row.fullName.split(' ');
      return `
        <li data-employee-id="${row.id}" tabindex="0">
          ${avatar(first, rest.join(' '), 'avatar--sm')}
          <div class="people-list__text">
            <div class="people-list__name">${escapeHtml(row.fullName)}</div>
            <div class="people-list__meta">${escapeHtml(row.jobTitle)} · ${escapeHtml(row.department)}</div>
          </div>
          <div class="people-list__date">${formatDate(row.hireDate)}</div>
        </li>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Employee directory
  // ---------------------------------------------------------------------------
  function buildQueryString({ paginate = true } = {}) {
    const params = new URLSearchParams();
    const { search, department, status, sortBy, sortOrder, page, pageSize } = state.query;
    if (search) params.set('search', search);
    if (department) params.set('department', department);
    if (status) params.set('status', status);
    params.set('sortBy', sortBy);
    params.set('sortOrder', sortOrder);
    if (paginate) {
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
    }
    return params.toString();
  }

  async function loadEmployees() {
    const seq = ++state.listRequestSeq;
    const table = $('#employeeTable');
    if (!state.employees.length) renderSkeletonRows();
    table.classList.add('is-loading');

    try {
      const result = await request(`${API.employees}?${buildQueryString()}`);
      if (seq !== state.listRequestSeq) return; // a newer request superseded this one

      if (result.data.length === 0 && result.pagination.total > 0 && state.query.page > result.pagination.totalPages) {
        state.query.page = result.pagination.totalPages;
        loadEmployees();
        return;
      }

      state.employees = result.data;
      state.pagination = result.pagination;
      renderEmployees();
      renderPagination();
    } catch (err) {
      if (seq !== state.listRequestSeq) return;
      state.employees = [];
      renderErrorState(err);
    } finally {
      if (seq === state.listRequestSeq) table.classList.remove('is-loading');
    }
    syncFilterUi();
  }

  function renderSkeletonRows() {
    const row = `
      <tr>
        <td><div class="employee-cell"><span class="skeleton skeleton--circle"></span><div style="flex:1"><span class="skeleton skeleton--line" style="width:140px"></span></div></div></td>
        ${'<td><span class="skeleton skeleton--line" style="width:90px"></span></td>'.repeat(6)}
        <td></td>
      </tr>`;
    $('#employeeTableBody').innerHTML = row.repeat(6);
  }

  function renderEmployees() {
    const tbody = $('#employeeTableBody');
    const { total, page, pageSize } = state.pagination;

    if (!state.employees.length) {
      const filtered = hasActiveFilters();
      tbody.innerHTML = `
        <tr class="empty-row"><td colspan="8">
          <div class="empty-state">
            <div class="empty-state__icon">${icon(filtered ? 'search' : 'users')}</div>
            <h3>${filtered ? 'No employees match your filters' : 'No employees yet'}</h3>
            <p>${filtered ? 'Try a different search term or clear the filters to see everyone.' : 'Add your first team member to get started.'}</p>
            ${filtered
              ? '<button class="btn btn--secondary" data-action="clear-filters">Clear filters</button>'
              : `<button class="btn btn--primary" data-action="add">${icon('plus')}Add employee</button>`}
          </div>
        </td></tr>`;
      $('#directorySummary').textContent = filtered ? 'No matching employees' : 'No employees';
      $('#paginationInfo').innerHTML = '&nbsp;';
      return;
    }

    tbody.innerHTML = state.employees.map((e) => `
      <tr data-id="${e.id}">
        <td data-label="Employee">
          <button class="employee-cell employee-cell__link" data-action="view" data-id="${e.id}">
            ${avatar(e.firstName, e.lastName)}
            <span class="employee-cell__text">
              <span class="employee-cell__name">${escapeHtml(e.fullName)}</span>
              <span class="employee-cell__email" title="${escapeHtml(e.email)}">${escapeHtml(e.email)}</span>
            </span>
          </button>
        </td>
        <td data-label="Job title" class="td-wrap">${escapeHtml(e.jobTitle)}</td>
        <td data-label="Department" class="td-wrap"><span class="dept"><span class="dept__swatch" style="--swatch:${deptColor(e.department)}"></span>${escapeHtml(e.department)}</span></td>
        <td data-label="Type"><span class="pill">${escapeHtml(e.employmentType)}</span></td>
        <td data-label="Status">${statusBadge(e.status)}</td>
        <td data-label="Location" class="td-wrap">${escapeHtml(e.location)}</td>
        <td data-label="Hire date">${formatDate(e.hireDate)}</td>
        <td class="table__actions">
          <div class="row-actions">
            <button class="icon-btn" data-action="view" data-id="${e.id}" title="View details" aria-label="View ${escapeHtml(e.fullName)}">${icon('eye')}</button>
            <button class="icon-btn" data-action="edit" data-id="${e.id}" title="Edit" aria-label="Edit ${escapeHtml(e.fullName)}">${icon('pencil')}</button>
            <button class="icon-btn icon-btn--danger" data-action="delete" data-id="${e.id}" title="Delete" aria-label="Delete ${escapeHtml(e.fullName)}">${icon('trash')}</button>
          </div>
        </td>
      </tr>`).join('');

    const from = (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    $('#paginationInfo').textContent = `Showing ${from}–${to} of ${numberFormatter.format(total)} employees`;
    $('#directorySummary').textContent = hasActiveFilters()
      ? `${numberFormatter.format(total)} matching employee${total === 1 ? '' : 's'}`
      : `${numberFormatter.format(total)} people in your organization`;
  }

  function renderErrorState(err) {
    $('#employeeTableBody').innerHTML = `
      <tr class="empty-row"><td colspan="8">
        <div class="empty-state">
          <div class="empty-state__icon empty-state__icon--error">${icon('alert')}</div>
          <h3>Couldn't load employees</h3>
          <p>${escapeHtml(err.message)}</p>
          <button class="btn btn--secondary" data-action="retry">${icon('refresh')}Try again</button>
        </div>
      </td></tr>`;
    $('#directorySummary').textContent = 'Unable to load data';
    $('#paginationInfo').innerHTML = '&nbsp;';
    $('#pagination').innerHTML = '';
  }

  function pageList(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
    if (current >= total - 2) [total - 1, total - 2, total - 3].forEach((p) => pages.add(p));
    const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const result = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) result.push('…');
      result.push(p);
    });
    return result;
  }

  function renderPagination() {
    const { page, totalPages, total } = state.pagination;
    const nav = $('#pagination');
    if (!total) {
      nav.innerHTML = '';
      return;
    }
    const buttons = pageList(page, totalPages).map((p) => (p === '…'
      ? '<span class="page-ellipsis">…</span>'
      : `<button class="page-btn ${p === page ? 'is-active' : ''}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`));
    nav.innerHTML = `
      <button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevron-left')}</button>
      ${buttons.join('')}
      <button class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevron-right')}</button>`;
  }

  function hasActiveFilters() {
    return Boolean(state.query.search || state.query.department || state.query.status);
  }

  function syncFilterUi() {
    const { search, department, status, sortBy, sortOrder, pageSize } = state.query;
    if ($('#directorySearch').value !== search) $('#directorySearch').value = search;
    if ($('#globalSearch').value !== search) $('#globalSearch').value = search;
    $('#departmentFilter').value = department;
    $('#statusFilter').value = status;
    $('#sortSelect').value = `${sortBy}:${sortOrder}`;
    $('#pageSizeSelect').value = String(pageSize);
    $('#clearFiltersBtn').hidden = !hasActiveFilters();

    $$('.th-sort').forEach((btn) => {
      const active = btn.dataset.sort === sortBy;
      btn.classList.toggle('is-active', active);
      $('use', btn).setAttribute('href', active ? (sortOrder === 'asc' ? '#i-arrow-up' : '#i-arrow-down') : '#i-sort');
    });
  }

  function updateQuery(changes) {
    Object.assign(state.query, changes);
    if (!('page' in changes)) state.query.page = 1;
    syncFilterUi();
    loadEmployees();
  }

  function clearFilters() {
    updateQuery({ search: '', department: '', status: '' });
  }

  const debouncedSearch = debounce((value) => updateQuery({ search: value.trim() }), 300);

  async function exportCsv() {
    const button = $('#exportBtn');
    button.disabled = true;
    try {
      const response = await request(`${API.exportCsv}?${buildQueryString({ paginate: false })}`, { raw: true, timeoutMs: 30000 });
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = match ? match[1] : 'employees.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('success', 'Export ready', 'Employee data was exported to CSV.');
    } catch (err) {
      showToast('error', 'Export failed', err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function refreshAfterChange() {
    await Promise.all([loadEmployees(), loadDashboard()]);
  }

  // ---------------------------------------------------------------------------
  // Employee form (add / edit)
  // ---------------------------------------------------------------------------
  const FORM_FIELDS = ['firstName', 'lastName', 'email', 'jobTitle', 'department', 'employmentType', 'status', 'hireDate', 'location', 'salary'];
  const NAME_PATTERN = /^[\p{L}\p{M}' .-]+$/u;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function openEmployeeForm(employee = null) {
    const form = $('#employeeForm');
    form.reset();
    clearFieldErrors();
    state.editingId = employee ? employee.id : null;

    if (employee && !state.departments.some((d) => d.name === employee.department)) {
      $('#department').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(employee.department)}">${escapeHtml(employee.department)}</option>`);
    }

    const values = employee || {
      employmentType: 'Full-time',
      status: 'Active',
      hireDate: todayIso(),
      department: state.query.department || '',
    };
    FORM_FIELDS.forEach((field) => {
      if (values[field] !== undefined && values[field] !== null) form.elements[field].value = values[field];
    });

    $('#employeeModalTitle').textContent = employee ? 'Edit employee' : 'Add employee';
    $('#employeeModalSubtitle').textContent = employee
      ? `Update ${employee.fullName}'s information.`
      : 'Fill in the details to add a new team member.';
    $('.btn__label', $('#employeeSubmitBtn')).textContent = employee ? 'Save changes' : 'Add employee';
    openModal($('#employeeModal'));
  }

  function readForm() {
    const form = $('#employeeForm');
    const data = {};
    FORM_FIELDS.forEach((field) => {
      const value = form.elements[field].value;
      data[field] = typeof value === 'string' ? value.trim() : value;
    });
    data.email = data.email.toLowerCase();
    data.salary = data.salary === '' ? '' : Number(data.salary);
    return data;
  }

  function validateForm(data) {
    const errors = {};
    const requireText = (field, label, min, max) => {
      if (!data[field]) errors[field] = `${label} is required`;
      else if (data[field].length < min || data[field].length > max) errors[field] = `${label} must be ${min}–${max} characters`;
    };

    requireText('firstName', 'First name', 1, 100);
    requireText('lastName', 'Last name', 1, 100);
    ['firstName', 'lastName'].forEach((field) => {
      if (!errors[field] && !NAME_PATTERN.test(data[field])) errors[field] = 'Only letters, spaces, apostrophes, dots and hyphens';
    });

    if (!data.email) errors.email = 'Email is required';
    else if (data.email.length > 255 || !EMAIL_PATTERN.test(data.email)) errors.email = 'Enter a valid email address';

    requireText('jobTitle', 'Job title', 2, 150);
    requireText('location', 'Location', 2, 150);
    if (!data.department) errors.department = 'Select a department';
    if (!EMPLOYMENT_TYPES.includes(data.employmentType)) errors.employmentType = 'Select an employment type';
    if (!STATUSES.includes(data.status)) errors.status = 'Select a status';

    if (!data.hireDate) errors.hireDate = 'Hire date is required';
    else {
      const max = new Date();
      max.setFullYear(max.getFullYear() + 1);
      const date = parseIsoDate(data.hireDate);
      if (!date || Number.isNaN(date.getTime()) || data.hireDate < '1950-01-01' || date > max) {
        errors.hireDate = 'Enter a date between 1950 and one year from today';
      }
    }

    if (data.salary === '' || data.salary === null) errors.salary = 'Salary is required';
    else if (!Number.isFinite(data.salary) || data.salary < 0 || data.salary > 99999999.99) errors.salary = 'Enter a salary between 0 and 99,999,999.99';
    else if (Math.round(data.salary * 100) !== Number((data.salary * 100).toFixed(6))) errors.salary = 'Use at most two decimal places';

    return errors;
  }

  function clearFieldErrors() {
    $$('#employeeForm .field').forEach((field) => field.classList.remove('has-error'));
    $$('#employeeForm [data-error-for]').forEach((el) => { el.textContent = ''; });
  }

  function showFieldErrors(errors) {
    clearFieldErrors();
    let first = null;
    Object.entries(errors).forEach(([field, message]) => {
      const target = $(`#employeeForm [data-error-for="${field}"]`);
      if (!target) return;
      target.textContent = message;
      target.closest('.field').classList.add('has-error');
      if (!first) first = $(`#employeeForm [name="${field}"]`);
    });
    if (first) first.focus();
  }

  async function submitEmployeeForm(event) {
    event.preventDefault();
    const data = readForm();
    const errors = validateForm(data);
    if (Object.keys(errors).length) {
      showFieldErrors(errors);
      return;
    }

    const button = $('#employeeSubmitBtn');
    setButtonLoading(button, true);
    const isEdit = state.editingId !== null;

    try {
      const { data: saved } = await request(isEdit ? `${API.employees}/${state.editingId}` : API.employees, {
        method: isEdit ? 'PUT' : 'POST',
        body: data,
      });
      closeModal($('#employeeModal'));
      showToast('success', isEdit ? 'Employee updated' : 'Employee added', `${saved.fullName} ${isEdit ? 'was updated successfully.' : 'has been added to the directory.'}`);
      await refreshAfterChange();
    } catch (err) {
      if (Array.isArray(err.details) && err.details.length) {
        showFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      }
      if (err.status === 404) {
        closeModal($('#employeeModal'));
        refreshAfterChange();
      }
      showToast('error', isEdit ? 'Could not update employee' : 'Could not add employee', err.message);
    } finally {
      setButtonLoading(button, false);
    }
  }

  // ---------------------------------------------------------------------------
  // Employee details
  // ---------------------------------------------------------------------------
  async function openEmployeeDetail(id) {
    const content = $('#detailContent');
    content.innerHTML = `
      <div class="detail__head">
        <span class="skeleton skeleton--circle" style="width:72px;height:72px"></span>
        <div style="flex:1"><span class="skeleton skeleton--line" style="width:180px;height:18px"></span></div>
      </div>
      <div class="detail-grid">${'<div class="detail-item"><span class="skeleton skeleton--line"></span></div>'.repeat(6)}</div>`;
    $('#detailEditBtn').disabled = true;
    $('#detailDeleteBtn').disabled = true;
    openModal($('#detailModal'));

    try {
      const { data } = await request(`${API.employees}/${encodeURIComponent(id)}`);
      state.detailEmployee = data;
      renderEmployeeDetail(data);
      $('#detailEditBtn').disabled = false;
      $('#detailDeleteBtn').disabled = false;
    } catch (err) {
      closeModal($('#detailModal'));
      showToast('error', 'Could not load employee', err.message);
      if (err.status === 404) refreshAfterChange();
    }
  }

  function renderEmployeeDetail(e) {
    const item = (iconName, label, value) => `
      <div class="detail-item">
        ${icon(iconName)}
        <div><div class="detail-item__label">${label}</div><div class="detail-item__value">${value}</div></div>
      </div>`;

    $('#detailContent').innerHTML = `
      <div class="detail__head">
        ${avatar(e.firstName, e.lastName, 'avatar--xl')}
        <div>
          <div class="detail__name" id="detailName">${escapeHtml(e.fullName)}</div>
          <div class="detail__title">${escapeHtml(e.jobTitle)}</div>
        </div>
        <div class="detail__badges">${statusBadge(e.status)}<span class="pill">${escapeHtml(e.employmentType)}</span></div>
      </div>
      <div class="detail-grid">
        ${item('mail', 'Email', `<a href="mailto:${escapeHtml(e.email)}">${escapeHtml(e.email)}</a>`)}
        ${item('building', 'Department', escapeHtml(e.department))}
        ${item('briefcase', 'Job title', escapeHtml(e.jobTitle))}
        ${item('map-pin', 'Location', escapeHtml(e.location))}
        ${item('calendar', 'Hire date', escapeHtml(formatDate(e.hireDate)))}
        ${item('dollar', 'Annual salary', escapeHtml(currencyFormatter.format(e.salary)))}
      </div>
      <div class="detail__meta">Employee #${e.id} · Created ${escapeHtml(formatDateTime(e.createdAt))} · Last updated ${escapeHtml(formatDateTime(e.updatedAt))}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  function confirmDelete(employee) {
    state.deleteTarget = employee;
    $('#confirmText').textContent = `${employee.fullName} will be permanently removed from PeopleDesk. This action cannot be undone.`;
    openModal($('#confirmModal'));
  }

  async function performDelete() {
    const target = state.deleteTarget;
    if (!target) return;
    const button = $('#confirmDeleteBtn');
    setButtonLoading(button, true);

    try {
      await request(`${API.employees}/${target.id}`, { method: 'DELETE' });
      closeModal($('#confirmModal'));
      closeModal($('#detailModal'));
      showToast('success', 'Employee deleted', `${target.fullName} was removed from the directory.`);
      await refreshAfterChange();
    } catch (err) {
      closeModal($('#confirmModal'));
      if (err.status === 404) {
        closeModal($('#detailModal'));
        showToast('error', 'Employee no longer exists', 'It may have been deleted by another user.');
        refreshAfterChange();
      } else {
        showToast('error', 'Could not delete employee', err.message);
      }
    } finally {
      setButtonLoading(button, false);
      state.deleteTarget = null;
    }
  }

  function findEmployee(id) {
    return state.employees.find((e) => String(e.id) === String(id));
  }

  async function handleDirectoryAction(action, id) {
    if (action === 'view') return openEmployeeDetail(id);
    if (action === 'retry') return loadEmployees();
    if (action === 'clear-filters') return clearFilters();
    if (action === 'add') return openEmployeeForm();

    const employee = findEmployee(id);
    if (!employee) return undefined;
    if (action === 'edit') return openEmployeeForm(employee);
    if (action === 'delete') return confirmDelete(employee);
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Departments view
  // ---------------------------------------------------------------------------
  async function loadDepartmentsView() {
    const grid = $('#departmentsGrid');
    if (!grid.children.length) {
      grid.innerHTML = '<div class="dept-card"><span class="skeleton skeleton--line"></span><span class="skeleton skeleton--line"></span></div>'.repeat(6);
    }
    try {
      const { data } = await request(API.departments);
      state.departments = data;
      renderDepartmentOptions();
      grid.innerHTML = data.map((d) => {
        const color = deptColor(d.name);
        return `
          <article class="dept-card">
            <div class="dept-card__top">
              <div class="dept-card__icon" style="background:${color}1a;color:${color}">${icon('building')}</div>
              <div class="dept-card__name">${escapeHtml(d.name)}</div>
            </div>
            <p class="dept-card__desc">${escapeHtml(d.description || 'No description')}</p>
            <div class="dept-card__stats">
              <div><div class="dept-card__stat-value">${d.employeeCount}</div><div class="dept-card__stat-label">Employees</div></div>
              <div><div class="dept-card__stat-value">${d.activeCount}</div><div class="dept-card__stat-label">Active</div></div>
            </div>
            <button class="btn btn--secondary btn--sm" data-department="${escapeHtml(d.name)}">${icon('users')}View employees</button>
          </article>`;
      }).join('') || '<p class="muted">No departments found.</p>';
    } catch (err) {
      grid.innerHTML = `
        <div class="card empty-state" style="grid-column:1/-1">
          <div class="empty-state__icon empty-state__icon--error">${icon('alert')}</div>
          <h3>Couldn't load departments</h3>
          <p>${escapeHtml(err.message)}</p>
        </div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Infrastructure: instance chip, readiness, system view
  // ---------------------------------------------------------------------------
  function describeInstance(info) {
    if (info.instanceId) return `${info.instanceId} · ${info.availabilityZone}`;
    return `Local · ${info.hostname}`;
  }

  async function loadInstanceChip() {
    try {
      const { data } = await request(API.instance);
      $('#instanceChipText').textContent = describeInstance(data);
    } catch {
      $('#instanceChipText').textContent = 'Instance unknown';
    }
  }

  async function probe(path) {
    const started = performance.now();
    try {
      const response = await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { ok: false, status: 0, body: null, latencyMs: Math.round(performance.now() - started) };
    }
  }

  async function pollReadiness() {
    if (document.hidden) return;
    const result = await probe(API.ready);
    const dot = $('#sidebarDbDot');
    const text = $('#sidebarDbText');
    if (result.ok && result.body) {
      dot.className = 'dot dot--green';
      text.textContent = `Connected · ${result.body.database.latencyMs} ms · ${result.body.database.role}`;
    } else {
      dot.className = 'dot dot--red';
      text.textContent = result.status ? 'Unavailable · retrying' : 'Server unreachable';
    }
  }

  async function loadSystemView() {
    const refreshIcon = $('#refreshSystemBtn .icon');
    refreshIcon.classList.add('is-spinning');

    const [instanceResult, health, ready] = await Promise.all([
      request(API.instance).then((r) => r.data).catch(() => null),
      probe(API.health),
      probe(API.ready),
    ]);
    refreshIcon.classList.remove('is-spinning');

    const kv = $('#instanceDetails');
    if (instanceResult) {
      const rows = [
        ['Platform', instanceResult.platform === 'ec2' ? 'Amazon EC2' : 'Local / non-EC2'],
        ['Instance ID', instanceResult.instanceId || '—'],
        ['Availability Zone', instanceResult.availabilityZone || '—'],
        ['Instance type', instanceResult.instanceType || '—'],
        ['Private IP', instanceResult.privateIp || '—'],
        ['Hostname', instanceResult.hostname],
        ['Node.js', instanceResult.nodeVersion],
        ['Process uptime', formatUptime(instanceResult.uptimeSeconds)],
      ];
      kv.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
      $('#instanceChipText').textContent = describeInstance(instanceResult);
    } else {
      kv.innerHTML = '<dt>Status</dt><dd>Unable to reach the application server</dd>';
    }

    const healthItem = (title, desc, result, okText, failText) => `
      <div class="health-item">
        <span class="dot ${result.ok ? 'dot--green' : 'dot--red'}"></span>
        <div class="health-item__text">
          <div class="health-item__title">${escapeHtml(title)}</div>
          <div class="health-item__desc">${escapeHtml(desc)}</div>
        </div>
        <span class="badge ${result.ok ? 'badge--active' : 'badge--leave'} badge--plain">${escapeHtml(result.ok ? okText : failText)} · ${result.status || 'n/a'}</span>
      </div>`;

    const dbInfo = ready.body && ready.body.database && ready.body.database.latencyMs !== undefined
      ? `Aurora reachable in ${ready.body.database.latencyMs} ms (${ready.body.database.role})`
      : 'Checks connectivity to the Aurora cluster endpoint';

    $('#healthChecks').innerHTML =
      healthItem('GET /health', 'Liveness · ALB target group health check (no DB dependency)', health, 'Healthy', 'Unhealthy') +
      healthItem('GET /ready', dbInfo, ready, 'Ready', 'Not ready');

    pollReadiness();
  }

  function formatUptime(seconds) {
    if (seconds === undefined) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
  }

  async function runLoadBalancerTest() {
    const button = $('#lbTestBtn');
    const results = $('#lbResults');
    button.disabled = true;
    results.innerHTML = '<p class="muted">Sending requests…</p>';

    const responses = await Promise.all(
      Array.from({ length: LB_TEST_REQUESTS }, () => request(API.instance).then((r) => r.data).catch(() => null)),
    );

    const tally = new Map();
    let failures = 0;
    responses.forEach((info) => {
      if (!info) { failures += 1; return; }
      const key = info.instanceId || info.hostname;
      const entry = tally.get(key) || { label: key, az: info.availabilityZone || 'local', count: 0 };
      entry.count += 1;
      tally.set(key, entry);
    });

    const entries = [...tally.values()].sort((a, b) => b.count - a.count);
    results.innerHTML = `
      ${entries.map((e) => `
        <div class="lb-row">
          <div class="lb-row__label">${escapeHtml(e.label)}<small>${escapeHtml(e.az)}</small></div>
          <div class="bar-track"><div class="bar-fill" style="width:${(e.count / LB_TEST_REQUESTS) * 100}%"></div></div>
          <div class="lb-row__count">${e.count}</div>
        </div>`).join('')}
      <p class="muted" style="margin-top:12px">
        ${entries.length} instance${entries.length === 1 ? '' : 's'} answered ${LB_TEST_REQUESTS - failures} of ${LB_TEST_REQUESTS} requests${failures ? ` · ${failures} failed` : ''}.
        ${entries.length === 1 ? 'Only one instance responded – expected when running locally or with a single healthy target.' : 'Traffic is being distributed across multiple targets.'}
      </p>`;
    button.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindEvents() {
    window.addEventListener('hashchange', handleRoute);

    $('#sidebarOpen').addEventListener('click', openSidebar);
    $('#sidebarClose').addEventListener('click', closeSidebar);
    $('#sidebarBackdrop').addEventListener('click', closeSidebar);

    $('#addEmployeeBtn').addEventListener('click', () => openEmployeeForm());
    $('#exportBtn').addEventListener('click', exportCsv);

    $('#directorySearch').addEventListener('input', (e) => {
      $('#globalSearch').value = e.target.value;
      debouncedSearch(e.target.value);
    });
    $('#globalSearch').addEventListener('input', (e) => {
      $('#directorySearch').value = e.target.value;
      if (state.route !== 'dashboard') navigate('dashboard');
      debouncedSearch(e.target.value);
    });

    $('#departmentFilter').addEventListener('change', (e) => updateQuery({ department: e.target.value }));
    $('#statusFilter').addEventListener('change', (e) => updateQuery({ status: e.target.value }));
    $('#sortSelect').addEventListener('change', (e) => {
      const [sortBy, sortOrder] = e.target.value.split(':');
      updateQuery({ sortBy, sortOrder });
    });
    $('#pageSizeSelect').addEventListener('change', (e) => updateQuery({ pageSize: Number(e.target.value) }));
    $('#clearFiltersBtn').addEventListener('click', clearFilters);

    $$('.th-sort').forEach((btn) => btn.addEventListener('click', () => {
      const sortBy = btn.dataset.sort;
      const sortOrder = state.query.sortBy === sortBy
        ? (state.query.sortOrder === 'asc' ? 'desc' : 'asc')
        : (sortBy === 'hireDate' ? 'desc' : 'asc');
      updateQuery({ sortBy, sortOrder });
    }));

    $('#pagination').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      const page = Number(btn.dataset.page);
      if (page >= 1 && page <= state.pagination.totalPages && page !== state.query.page) {
        updateQuery({ page });
        $('.directory').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    $('#employeeTableBody').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (target) handleDirectoryAction(target.dataset.action, target.dataset.id);
    });

    const openRecentHire = (e) => {
      const item = e.target.closest('[data-employee-id]');
      if (item) openEmployeeDetail(item.dataset.employeeId);
    };
    $('#recentHires').addEventListener('click', openRecentHire);
    $('#recentHires').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRecentHire(e); });

    $('#departmentsGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-department]');
      if (!btn) return;
      Object.assign(state.query, { department: btn.dataset.department, search: '', status: '', page: 1 });
      navigate('dashboard');
    });

    $('#employeeForm').addEventListener('submit', submitEmployeeForm);
    $('#employeeForm').addEventListener('input', (e) => {
      const field = e.target.closest('.field');
      if (field && field.classList.contains('has-error')) {
        field.classList.remove('has-error');
        $('[data-error-for]', field).textContent = '';
      }
    });

    $('#detailEditBtn').addEventListener('click', () => {
      const employee = state.detailEmployee;
      if (!employee) return;
      closeModal($('#detailModal'));
      openEmployeeForm(employee);
    });
    $('#detailDeleteBtn').addEventListener('click', () => {
      if (state.detailEmployee) confirmDelete(state.detailEmployee);
    });
    $('#confirmDeleteBtn').addEventListener('click', performDelete);

    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', () => closeModal(el.closest('.modal'))));

    $('#refreshSystemBtn').addEventListener('click', loadSystemView);
    $('#lbTestBtn').addEventListener('click', runLoadBalancerTest);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = topmostOpenModal();
        if (modal) closeModal(modal);
        else closeSidebar();
        return;
      }
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (e.key === '/' && !typing && !topmostOpenModal()) {
        e.preventDefault();
        $('#globalSearch').focus();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollReadiness();
    });
  }

  async function init() {
    bindEvents();
    syncFilterUi();
    await loadDepartments();
    handleRoute();
    loadInstanceChip();
    pollReadiness();
    setInterval(pollReadiness, READY_POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
