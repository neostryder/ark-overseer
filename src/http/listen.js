// The default address "::" answers on IPv6 and, because the socket is dual-stack, on IPv4 too, so
// http://[::1]:3310 and http://127.0.0.1:3310 both reach ARK Overseer. A computer with IPv6 turned
// off refuses "::", and then ARK Overseer listens on every IPv4 address instead.
export const DEFAULT_HOST = '::';
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL']);

function listenOnce(server, options) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', done);
      reject(error);
    };
    const done = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', done);
    server.listen(options);
  });
}

export async function listen(server, port, host = DEFAULT_HOST) {
  if (host !== DEFAULT_HOST) return listenOnce(server, { port, host });
  try {
    await listenOnce(server, { port, host, ipv6Only: false });
  } catch (error) {
    if (!NO_IPV6.has(error.code)) throw error;
    await listenOnce(server, { port, host: '0.0.0.0' });
  }
}
