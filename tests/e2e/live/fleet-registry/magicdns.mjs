/**
 * Resolves MagicDNS names for the processes this rig starts.
 *
 * Loaded with `node --import`, so it must run before anything opens a socket.
 *
 * ── why it exists ───────────────────────────────────────────────────────────
 * The tailnet profile addresses each node by the name `tailscale serve`
 * terminates TLS for — `https://<node>.tailae910a.ts.net:8443` — because that
 * is the name the certificate is issued for, and dialling the tailnet IP
 * instead would mean either no TLS or an unverified one.
 *
 * On the Mac this rig runs on, MagicDNS is configured and broken: the scoped
 * resolver for `tailae910a.ts.net` is `100.100.100.100`, `dig` against it
 * answers correctly, and `scutil --dns` still reports `reach: Not Reachable`,
 * so `getaddrinfo` — and therefore every Node socket — refuses the name. The
 * two documented repairs (an `/etc/hosts` pin, an `/etc/resolver` file) both
 * need root, which an unattended run does not have.
 *
 * So this asks the tailnet resolver directly for `*.ts.net`, and hands
 * everything else to the OS unchanged. It is not a workaround for a product
 * defect: on a host whose resolver works, the patched path returns exactly
 * what `getaddrinfo` would have. It is rig-only and deliberately narrow —
 * nothing in `scripts/` knows it exists.
 */

import dns from "node:dns";
import { Resolver } from "node:dns/promises";

const MAGICDNS_SERVER = process.env.FLEET_RIG_MAGICDNS ?? "100.100.100.100";
const MAGIC_SUFFIX = /\.ts\.net\.?$/i;

const resolver = new Resolver();
resolver.setServers([MAGICDNS_SERVER]);

const systemLookup = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const opts = typeof options === "number" ? { family: options } : (options ?? {});

  if (typeof hostname !== "string" || !MAGIC_SUFFIX.test(hostname)) {
    return systemLookup.call(dns, hostname, options, callback);
  }

  resolver
    .resolve4(hostname)
    .then((addresses) => {
      const [address] = addresses;
      if (!address) throw new Error(`no A record for ${hostname}`);
      if (opts.all) {
        callback(
          null,
          addresses.map((each) => ({ address: each, family: 4 })),
        );
      } else {
        callback(null, address, 4);
      }
    })
    .catch(() => {
      // A name the tailnet resolver cannot answer is not automatically a
      // failure — it may be a public `ts.net` name — so fall back rather than
      // inventing an error the OS would not have produced.
      systemLookup.call(dns, hostname, options, callback);
    });

  return undefined;
};
