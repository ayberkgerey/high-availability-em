-- =============================================================================
-- PeopleDesk – Employee Management
-- Schema for Amazon Aurora MySQL-Compatible (Aurora MySQL 3.x / MySQL 8.0;
-- also runs on Aurora MySQL 2.x / MySQL 5.7, where CHECK constraints are ignored).
--
-- Idempotent: safe to run multiple times. Run against the Aurora CLUSTER (writer) endpoint:
--   mysql -h <cluster-endpoint> -u admin -p < database/schema.sql
-- =============================================================================

CREATE DATABASE IF NOT EXISTS employee_management
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE employee_management;

-- -----------------------------------------------------------------------------
-- departments: lookup table referenced by employees.department.
-- Keeps department names consistent and lets the UI list departments with
-- zero employees.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100)  NOT NULL,
  description VARCHAR(255)  NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_name (name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- employees
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_name      VARCHAR(100)    NOT NULL,
  last_name       VARCHAR(100)    NOT NULL,
  email           VARCHAR(255)    NOT NULL,
  job_title       VARCHAR(150)    NOT NULL,
  department      VARCHAR(100)    NOT NULL,
  employment_type ENUM('Full-time', 'Part-time', 'Contract') NOT NULL DEFAULT 'Full-time',
  status          ENUM('Active', 'On Leave', 'Inactive')     NOT NULL DEFAULT 'Active',
  salary          DECIMAL(10, 2)  NOT NULL,
  hire_date       DATE            NOT NULL,
  location        VARCHAR(150)    NOT NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_email (email),
  KEY idx_employees_department_status (department, status),
  KEY idx_employees_status (status),
  KEY idx_employees_name (last_name, first_name),
  KEY idx_employees_hire_date (hire_date),
  CONSTRAINT fk_employees_department
    FOREIGN KEY (department) REFERENCES departments (name)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT chk_employees_salary CHECK (salary >= 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Seed data (INSERT IGNORE keeps re-runs idempotent thanks to unique keys)
-- -----------------------------------------------------------------------------
INSERT IGNORE INTO departments (name, description) VALUES
  ('Engineering',      'Builds and operates the PeopleDesk platform'),
  ('Product',          'Product strategy, roadmap and discovery'),
  ('Design',           'Product design, research and brand'),
  ('Marketing',        'Demand generation, content and communications'),
  ('Sales',            'New business and account management'),
  ('Customer Success', 'Onboarding, support and retention'),
  ('Human Resources',  'Talent acquisition, people operations and culture'),
  ('Finance',          'Accounting, FP&A and payroll'),
  ('Operations',       'Business operations, IT and facilities'),
  ('Legal',            'Contracts, compliance and privacy');

INSERT IGNORE INTO employees
  (first_name, last_name, email, job_title, department, employment_type, status, salary, hire_date, location)
VALUES
  ('Olivia',   'Bennett',   'olivia.bennett@peopledesk.io',   'VP of Engineering',             'Engineering',      'Full-time', 'Active',   215000.00, '2018-03-12', 'Seattle, WA'),
  ('Liam',     'Carter',    'liam.carter@peopledesk.io',      'Senior Backend Engineer',       'Engineering',      'Full-time', 'Active',   168000.00, '2019-07-01', 'Austin, TX'),
  ('Sofia',    'Martinez',  'sofia.martinez@peopledesk.io',   'Cloud Infrastructure Engineer', 'Engineering',      'Full-time', 'Active',   162500.00, '2020-02-17', 'Remote'),
  ('Noah',     'Kim',       'noah.kim@peopledesk.io',         'Frontend Engineer',             'Engineering',      'Full-time', 'On Leave', 138000.00, '2021-05-24', 'San Francisco, CA'),
  ('Ava',      'Nguyen',    'ava.nguyen@peopledesk.io',       'Site Reliability Engineer',     'Engineering',      'Full-time', 'Active',   171000.00, '2021-09-13', 'Dublin, Ireland'),
  ('Ethan',    'Patel',     'ethan.patel@peopledesk.io',      'QA Automation Engineer',        'Engineering',      'Contract',  'Active',    95000.00, '2023-01-09', 'Bengaluru, India'),
  ('Mia',      'Schmidt',   'mia.schmidt@peopledesk.io',      'Data Engineer',                 'Engineering',      'Full-time', 'Active',   149000.00, '2022-04-04', 'Berlin, Germany'),
  ('Lucas',    'Rossi',     'lucas.rossi@peopledesk.io',      'Junior Software Engineer',      'Engineering',      'Full-time', 'Active',    98000.00, '2024-08-19', 'Milan, Italy'),
  ('Isabella', 'Clarke',    'isabella.clarke@peopledesk.io',  'Director of Product',           'Product',          'Full-time', 'Active',   189000.00, '2019-01-28', 'New York, NY'),
  ('James',    'O''Connor', 'james.oconnor@peopledesk.io',    'Senior Product Manager',        'Product',          'Full-time', 'Active',   158000.00, '2020-10-05', 'Boston, MA'),
  ('Amelia',   'Yilmaz',    'amelia.yilmaz@peopledesk.io',    'Product Analyst',               'Product',          'Part-time', 'Active',    72000.00, '2023-06-12', 'Istanbul, Turkey'),
  ('Harper',   'Lindqvist', 'harper.lindqvist@peopledesk.io', 'Lead Product Designer',         'Design',           'Full-time', 'Active',   146000.00, '2019-11-18', 'Stockholm, Sweden'),
  ('Benjamin', 'Dubois',    'benjamin.dubois@peopledesk.io',  'UX Researcher',                 'Design',           'Contract',  'Inactive',  88000.00, '2022-02-07', 'Paris, France'),
  ('Charlotte','Evans',     'charlotte.evans@peopledesk.io',  'Product Designer',              'Design',           'Full-time', 'Active',   118000.00, '2023-03-20', 'London, UK'),
  ('Henry',    'Walker',    'henry.walker@peopledesk.io',     'Head of Marketing',             'Marketing',        'Full-time', 'Active',   176000.00, '2018-09-03', 'Chicago, IL'),
  ('Evelyn',   'Tanaka',    'evelyn.tanaka@peopledesk.io',    'Content Marketing Manager',     'Marketing',        'Full-time', 'On Leave', 104000.00, '2021-03-15', 'Remote'),
  ('Alexander','Moreno',    'alexander.moreno@peopledesk.io', 'Growth Marketing Specialist',   'Marketing',        'Full-time', 'Active',    92000.00, '2022-11-28', 'Madrid, Spain'),
  ('Abigail',  'Foster',    'abigail.foster@peopledesk.io',   'VP of Sales',                   'Sales',            'Full-time', 'Active',   205000.00, '2018-05-21', 'New York, NY'),
  ('Daniel',   'Hughes',    'daniel.hughes@peopledesk.io',    'Account Executive',             'Sales',            'Full-time', 'Active',   112000.00, '2020-08-10', 'Denver, CO'),
  ('Emily',    'Novak',     'emily.novak@peopledesk.io',      'Sales Development Rep',         'Sales',            'Full-time', 'Active',    68000.00, '2024-02-05', 'Prague, Czechia'),
  ('Matthew',  'Silva',     'matthew.silva@peopledesk.io',    'Enterprise Account Executive',  'Sales',            'Full-time', 'Inactive', 128000.00, '2019-04-15', 'Sao Paulo, Brazil'),
  ('Ella',     'Murphy',    'ella.murphy@peopledesk.io',      'Customer Success Manager',      'Customer Success', 'Full-time', 'Active',    96000.00, '2021-01-11', 'Dublin, Ireland'),
  ('Jack',     'Andersen',  'jack.andersen@peopledesk.io',    'Support Engineer',              'Customer Success', 'Part-time', 'Active',    58000.00, '2023-09-25', 'Copenhagen, Denmark'),
  ('Grace',    'Okafor',    'grace.okafor@peopledesk.io',     'Onboarding Specialist',         'Customer Success', 'Full-time', 'On Leave',  74000.00, '2022-07-18', 'Lagos, Nigeria'),
  ('Samuel',   'Cohen',     'samuel.cohen@peopledesk.io',     'HR Business Partner',           'Human Resources',  'Full-time', 'Active',   108000.00, '2020-06-01', 'Toronto, Canada'),
  ('Chloe',    'Fischer',   'chloe.fischer@peopledesk.io',    'Talent Acquisition Lead',       'Human Resources',  'Full-time', 'Active',   101000.00, '2021-10-04', 'Munich, Germany'),
  ('Leo',      'Demir',     'leo.demir@peopledesk.io',        'People Operations Coordinator', 'Human Resources',  'Contract',  'Active',    61000.00, '2024-05-13', 'Ankara, Turkey'),
  ('Zoe',      'Campbell',  'zoe.campbell@peopledesk.io',     'Finance Manager',               'Finance',          'Full-time', 'Active',   132000.00, '2019-08-26', 'Edinburgh, UK'),
  ('William',  'Park',      'william.park@peopledesk.io',     'Payroll Specialist',            'Finance',          'Part-time', 'Active',    64000.00, '2022-12-05', 'Seoul, South Korea'),
  ('Lily',     'Johansson', 'lily.johansson@peopledesk.io',   'Financial Analyst',             'Finance',          'Full-time', 'Active',    89000.00, '2023-04-17', 'Oslo, Norway'),
  ('Owen',     'Reyes',     'owen.reyes@peopledesk.io',       'IT Operations Manager',         'Operations',       'Full-time', 'Active',   119000.00, '2020-01-20', 'Phoenix, AZ'),
  ('Nora',     'Kowalski',  'nora.kowalski@peopledesk.io',    'Business Operations Analyst',   'Operations',       'Full-time', 'Active',    86000.00, '2023-10-02', 'Warsaw, Poland'),
  ('Elijah',   'Grant',     'elijah.grant@peopledesk.io',     'General Counsel',               'Legal',            'Full-time', 'Active',   198000.00, '2019-02-11', 'Washington, DC'),
  ('Aria',     'Hosseini',  'aria.hosseini@peopledesk.io',    'Privacy & Compliance Counsel',  'Legal',            'Contract',  'Active',   125000.00, '2025-01-06', 'Amsterdam, Netherlands');

-- -----------------------------------------------------------------------------
-- Least-privilege application user (run once as the Aurora master user).
-- Replace the password, then store the same values in AWS Secrets Manager.
-- -----------------------------------------------------------------------------
-- CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'REPLACE_WITH_STRONG_PASSWORD';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON employee_management.* TO 'app_user'@'%';
-- FLUSH PRIVILEGES;
