// On these routes a 401 means a wrong password, which the page shows, not a lapsed session.
const PASSWORD_CHECKS = new Set(['/api/auth/login', '/api/auth/password']);
async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(path, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (response.status === 401 && !PASSWORD_CHECKS.has(path)) window.location.assign('/login.html');
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    for (const key of ['code', 'errors', 'conflicts', 'script']) if (data[key] !== undefined) error[key] = data[key];
    throw error;
  }
  return data;
}
export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
};
