'use strict';

const os = require('os');
const config = require('../config');
const logger = require('../utils/logger');

const IMDS_BASE_URL = 'http://169.254.169.254/latest';
const IMDS_TIMEOUT_MS = 1000;

let cachedInfo = null;
let pending = null;

async function imdsRequest(path, options = {}) {
  const response = await fetch(`${IMDS_BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`IMDS ${path} returned HTTP ${response.status}`);
  return response.text();
}

async function loadFromImds() {
  // IMDSv2: obtain a session token first.
  const token = await imdsRequest('/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
  });
  const headers = { 'X-aws-ec2-metadata-token': token };
  const [instanceId, availabilityZone, instanceType, privateIp] = await Promise.all([
    imdsRequest('/meta-data/instance-id', { headers }),
    imdsRequest('/meta-data/placement/availability-zone', { headers }),
    imdsRequest('/meta-data/instance-type', { headers }),
    imdsRequest('/meta-data/local-ipv4', { headers }),
  ]);
  return { instanceId, availabilityZone, instanceType, privateIp };
}

/**
 * Identifies the instance serving the request, so the UI can show which EC2 instance /
 * Availability Zone the load balancer routed to. Falls back to the hostname off EC2.
 */
async function getInstanceInfo() {
  if (cachedInfo) return cachedInfo;
  if (!pending) {
    pending = (async () => {
      const base = { hostname: os.hostname(), platform: 'local', nodeVersion: process.version };
      if (!config.ec2MetadataEnabled) return base;
      try {
        const ec2 = await loadFromImds();
        return { ...base, platform: 'ec2', ...ec2 };
      } catch (err) {
        logger.info('EC2 instance metadata not available, assuming local environment', {
          reason: err.message,
        });
        return base;
      }
    })().then((info) => {
      cachedInfo = info;
      pending = null;
      return info;
    });
  }
  return pending;
}

module.exports = { getInstanceInfo };
