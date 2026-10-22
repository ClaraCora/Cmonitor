import assert from "node:assert/strict"
import { Resolver } from "node:dns"
import { readFileSync } from "node:fs"
import { checkServerIdentity } from "node:tls"
import { brotliCompressSync, brotliDecompressSync } from "node:zlib"

const baseline = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()
const [major, minor, patch] = process.versions.node.split(".").map(Number)
const [requiredMajor, requiredMinor, requiredPatch] = baseline.split(".").map(Number)

console.log(`Node ${process.versions.node}; Brotli ${process.versions.brotli}; ${process.execPath}`)
assert.ok(
  major === requiredMajor &&
    (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch)),
  `Use Node ${baseline} or a newer patch in the same major release line`,
)

// A fixed runtime rejects the input before issuing a DNS query. Keep the
// resolver on loopback even if this regression returns in a future build.
const resolver = new Resolver()
resolver.setServers(["127.0.0.1:9"])
assert.throws(
  () => resolver.resolve4("example.invalid\u0000.trusted.invalid", () => {}),
  { code: "ERR_INVALID_ARG_VALUE" },
)

// These checks use certificate descriptions in memory; no TLS connection is
// made. Include valid hostnames so a blanket certificate rejection cannot pass.
for (const host of ["１２７.０.０.１", "127.1", "0177.0.0.1", "0x7f000001"]) {
  const error = checkServerIdentity(host, { subjectaltname: `DNS:${host}` })
  assert.equal(error?.code, "ERR_TLS_CERT_ALTNAME_INVALID", host)
  assert.match(error.reason, /non-canonical IP/)
}
assert.equal(checkServerIdentity("example.invalid", { subjectaltname: "DNS:example.invalid" }), undefined)
assert.equal(checkServerIdentity("127.0.0.1", { subjectaltname: "IP Address:127.0.0.1" }), undefined)

// Exercise normal compression only. The patched Node version above is the
// security requirement; this round trip is not an exploit or a memory-safety proof.
const input = Buffer.from("Cmonitor Brotli runtime check")
assert.deepEqual(brotliDecompressSync(brotliCompressSync(input)), input)

console.log("PASS: Node security baseline, DNS/TLS regression checks and Brotli round trip")
