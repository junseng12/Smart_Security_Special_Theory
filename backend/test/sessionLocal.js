const { v4: uuidv4 } = require('uuid');

function createSession({ userAddress, serviceType, depositUsdc, meta = {} }) {
  return { id: uuidv4(), userAddress, serviceType, depositUsdc, status: 'Active', meta, createdAt: Date.now() };
}

function updateSession(session, newStatus, extra = {}) {
  return { ...session, status: newStatus, ...extra, updatedAt: Date.now() };
}

module.exports = { createSession, updateSession };
