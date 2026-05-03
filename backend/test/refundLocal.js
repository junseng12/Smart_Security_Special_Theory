const { v4: uuidv4 } = require('uuid');

function createCase({ userAddress, reason, requestedUsdc, evidence = [] }) {
  return { id: `case_${uuidv4().slice(0,8)}`, userAddress, reason, requestedUsdc, status: 'RECEIVED', evidence, createdAt: Date.now() };
}

function updateCase(c, newStatus, extra = {}) {
  return { ...c, status: newStatus, ...extra, updatedAt: Date.now() };
}

module.exports = { createCase, updateCase };
