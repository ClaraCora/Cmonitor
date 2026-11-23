"""Build the test Agent with a private trust root and relay its WSS connection to the local Hub."""
import asyncio
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys


def prepare(source, work):
    work.mkdir(mode=0o700)
    tree = work / "agent"
    shutil.copytree(source / "src", tree / "src")
    for name in ("Cargo.toml", "Cargo.lock"):
        shutil.copy2(source / name, tree / name)

    def openssl(*args):
        subprocess.run(["openssl", *args], cwd=work, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)

    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Cmonitor test CA",
            "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign",
            "-keyout", "ca.key", "-out", "ca.pem")
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "leaf.key",
            "-out", "leaf.csr")
    (work / "leaf.ext").write_text("basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
                                   "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n")
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
            "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem")
    openssl("x509", "-in", "ca.pem", "-outform", "DER", "-out", "agent/src/smoke-ca.der")
    (work / "ca.key").unlink()

    main = tree / "src" / "main.rs"
    source = main.read_text()
    call = "let connect = tokio_tungstenite::connect_async_with_config(request, Some(config), false);"
    if source.count(call) != 1:
        raise ValueError("smoke Agent TLS connector changed; review the fixture against the pinned source")
    main.write_text(source.replace(call, """
    let mut roots = rustls::RootCertStore::empty();
    roots.add(rustls::pki_types::CertificateDer::from(&include_bytes!("smoke-ca.der")[..]))?;
    let tls = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    let connector = tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(tls));
    let connect = tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, Some(connector));
    """))


async def proxy(work, upstream_port, ready):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(work / "leaf.pem", work / "leaf.key")

    async def copy(reader, writer):
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()

    async def relay(client, downstream):
        upstream = None
        tasks = []
        try:
            headers = await asyncio.wait_for(client.readuntil(b"\r\n\r\n"), timeout=5)
            peer, upstream = await asyncio.open_connection("127.0.0.1", upstream_port)
            upstream.write(headers[:-2] + b"X-Forwarded-Proto: https\r\n\r\n")
            await upstream.drain()
            tasks = [asyncio.create_task(copy(client, upstream)), asyncio.create_task(copy(peer, downstream))]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if upstream:
                upstream.close()
            downstream.close()

    server = await asyncio.start_server(relay, "127.0.0.1", 0, ssl=context)
    ready.write_text(str(server.sockets[0].getsockname()[1]))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        os.umask(0o077)
        prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "proxy":
        asyncio.run(proxy(Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4])))
