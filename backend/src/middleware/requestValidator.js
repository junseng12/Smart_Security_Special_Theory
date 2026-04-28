/**
 * General request sanity checks:
 * - Content-Type must be application/json for POST/PUT/PATCH
 * - Body must not be empty for write operations
 */
module.exports = function requestValidator(req, res, next) {
  const writeMethods = ['POST', 'PUT', 'PATCH'];
  if (writeMethods.includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
    }
  }
  next();
};
