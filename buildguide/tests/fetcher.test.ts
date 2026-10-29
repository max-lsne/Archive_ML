import { describe, expect, it } from "vitest";
import { hostIsPrivateLiteral, isPdf, isPrivateAddress, normalizeUrl, parseHtml, rankPdfCandidates, scorePdfCandidate, sniffImage } from "../server/src/fetcher";
import { parseLooseJson } from "../server/src/planner";

describe("parseHtml", () => {
  const html = `<html><head><title>BILLY Bookcase, white, 80x28x202 cm</title>
  <meta property="og:image" content="/img/billy.jpg"><meta name="description" content="A classic"></head>
  <body><nav>skip me</nav><main><h1>BILLY</h1><p>Assembly instructions</p>
  <a href="/manuals/billy-AA-1844854-7.pdf">Assembly instructions</a>
  <a href="https://cdn.example.com/warranty.pdf">Warranty</a>
  <script>var x = {"assemblyInstructions":"https:\\/\\/www.example.com\\/assets\\/AA-123456-1.pdf"}</script>
  <img src="/img/billy-front.jpg" width="800"><img src="/img/logo.png"></main></body></html>`;
  const page = parseHtml(html, "https://www.example.com/p/billy");

  it("extracts title, description, og:image", () => {
    expect(page.title).toContain("BILLY");
    expect(page.description).toBe("A classic");
    expect(page.ogImage).toBe("https://www.example.com/img/billy.jpg");
  });
  it("ranks the assembly PDF above the warranty", () => {
    expect(page.pdfCandidates[0].url).toContain("billy-AA-1844854-7.pdf");
    expect(page.pdfCandidates.find((c) => c.url.includes("warranty"))!.score).toBeLessThan(0);
  });
  it("finds PDFs embedded in escaped JSON", () => {
    expect(page.pdfCandidates.some((c) => c.url === "https://www.example.com/assets/AA-123456-1.pdf")).toBe(true);
  });
  it("keeps product images but skips logos and nav text", () => {
    expect(page.imageCandidates).toEqual(["https://www.example.com/img/billy-front.jpg"]);
    expect(page.text).not.toContain("skip me");
    expect(page.text).toContain("BILLY\nAssembly instructions");
  });
});

describe("parseHtml candidate hygiene", () => {
  const html = `<html><body><main>
  <a href="#assembly">Assembly instructions</a>
  <a href="https://shop.example.com/p/desk#assembly">Assembly instructions</a>
  <a href="/guides/buying-guide">Buying guide</a>
  <a href="/docs/desk-manual.pdf"><img src="/i/pdf.png"></a>
  </main></body></html>`;
  const page = parseHtml(html, "https://shop.example.com/p/desk");

  it("ignores in-page anchors and links back to the page itself", () => {
    expect(page.pdfCandidates.some((c) => c.url === "https://shop.example.com/p/desk")).toBe(false);
    expect(page.pdfCandidates.some((c) => c.url.endsWith("#assembly"))).toBe(false);
  });
  it("still ranks the real PDF first even with an image-only anchor", () => {
    expect(page.pdfCandidates[0].url).toBe("https://shop.example.com/docs/desk-manual.pdf");
  });
});

describe("scorePdfCandidate", () => {
  it("prefers manual-like names", () => {
    expect(scorePdfCandidate("https://x.com/a/pitching-guide.pdf", "")).toBeGreaterThan(scorePdfCandidate("https://x.com/a/catalogue.pdf", ""));
  });
});

describe("normalizeUrl", () => {
  it("adds https and rejects junk", () => {
    expect(normalizeUrl("ikea.com/x").toString()).toBe("https://ikea.com/x");
    expect(() => normalizeUrl("ftp://x")).toThrow("Only http(s) links are supported.");
    expect(() => normalizeUrl("mailto:bob@example.com")).toThrow("Only http(s) links are supported.");
    expect(() => normalizeUrl("not a url")).toThrow();
  });
  it("treats host:port as a host, not a scheme", () => {
    expect(normalizeUrl("example.com:8080/manual.pdf").toString()).toBe("https://example.com:8080/manual.pdf");
    expect(normalizeUrl("www.ikea.com:443/x").toString()).toBe("https://www.ikea.com/x");
    expect(normalizeUrl("http://example.com:8080/a").toString()).toBe("http://example.com:8080/a");
  });
});

describe("private-host detection", () => {
  it("flags private IPv4 and IPv6 ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fc00::1", "fe80::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it("judges IPv4-mapped IPv6 by the embedded address", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
  });
  it("sees through bracketed IPv6 literals and local names", () => {
    expect(hostIsPrivateLiteral("[::1]")).toBe(true);
    expect(hostIsPrivateLiteral("[::ffff:7f00:1]")).toBe(true);
    expect(hostIsPrivateLiteral("[fd00::1]")).toBe(true);
    expect(hostIsPrivateLiteral("[2606:4700::1111]")).toBe(false);
    expect(hostIsPrivateLiteral("127.0.0.1")).toBe(true);
    expect(hostIsPrivateLiteral("localhost")).toBe(true);
    expect(hostIsPrivateLiteral("api.localhost")).toBe(true);
    expect(hostIsPrivateLiteral("printer.local")).toBe(true);
    expect(hostIsPrivateLiteral("db.internal")).toBe(true);
    // DNS names are undecided here (resolved later)
    expect(hostIsPrivateLiteral("www.ikea.com")).toBeNull();
  });
  it("new URL keeps IPv6 brackets in hostname (the bug this guards against)", () => {
    expect(new URL("http://[::1]:8787/x").hostname).toBe("[::1]");
  });
});

describe("rankPdfCandidates", () => {
  it("puts real .pdf links ahead of higher-scoring HTML pages", () => {
    const ranked = rankPdfCandidates([
      { url: "https://x.com/assembly-instructions", text: "Assembly instructions", score: 9 },
      { url: "https://x.com/install-guide", text: "Installation guide", score: 9 },
      { url: "https://x.com/docs/aa-1234567-8.pdf", text: "", score: 8 },
      { url: "https://x.com/docs/other.pdf?v=2", text: "", score: 2 },
    ]);
    expect(ranked.map((c) => c.url)).toEqual([
      "https://x.com/docs/aa-1234567-8.pdf",
      "https://x.com/docs/other.pdf?v=2",
      "https://x.com/assembly-instructions",
      "https://x.com/install-guide",
    ]);
  });
  it("parseHtml returns candidates already ranked that way", () => {
    const page = parseHtml(
      `<a href="/assembly-instructions">Assembly instructions</a><a href="/warranty.pdf">Warranty</a><a href="/aa-55555-1.pdf"><img src="/i.png"></a>`,
      "https://x.com/p/1",
    );
    expect(page.pdfCandidates[0].url).toBe("https://x.com/aa-55555-1.pdf");
    expect(page.pdfCandidates.every((c, i, arr) => i === 0 || /\.pdf/.test(arr[i - 1].url) || !/\.pdf/.test(c.url))).toBe(true);
  });
});

describe("parseHtml escaped JSON URLs", () => {
  it("finds PDF links serialised with \\u002F escapes", () => {
    const html = `<html><body><script>window.__data = {"manual":"https:\\u002F\\u002Fcdn.example.com\\u002Fdocs\\u002Fmanual.pdf"}</script></body></html>`;
    const page = parseHtml(html, "https://shop.example.com/p/desk");
    expect(page.pdfCandidates.map((c) => c.url)).toContain("https://cdn.example.com/docs/manual.pdf");
  });
  it("finds PDF links serialised with \\/ escapes (lower-case u002f too)", () => {
    const html = `<script>{"a":"https:\\/\\/cdn.example.com\\/a.pdf","b":"https:\\u002f\\u002fcdn.example.com\\u002fb.pdf"}</script>`;
    const urls = parseHtml(html, "https://shop.example.com/").pdfCandidates.map((c) => c.url);
    expect(urls).toContain("https://cdn.example.com/a.pdf");
    expect(urls).toContain("https://cdn.example.com/b.pdf");
  });
});

describe("isPdf", () => {
  const pdf = Buffer.from("%PDF-1.4\n%junk");
  const json = Buffer.from('{"error":"denied"}');
  it("accepts the magic bytes whatever the content type", () => {
    expect(isPdf("application/octet-stream", pdf)).toBe(true);
    expect(isPdf("", pdf)).toBe(true);
  });
  it("accepts an explicit application/pdf content type (loadPdf then validates)", () => {
    expect(isPdf("application/pdf; charset=binary", json)).toBe(true);
  });
  it("rejects non-PDF bodies even at a .pdf URL", () => {
    expect(isPdf("application/json", json)).toBe(false);
    expect(isPdf("application/octet-stream", Buffer.from("<html>denied</html>"))).toBe(false);
    expect(isPdf("text/html", Buffer.from("<html>"))).toBe(false);
  });
});

describe("parseLooseJson", () => {
  it("reports malformed output with a friendly error", () => {
    expect(() => parseLooseJson('{"a":1} {"b":2}')).toThrow("Claude's answer was not valid JSON.");
    expect(() => parseLooseJson('{"a":[1,2')).toThrow("Claude's answer was not valid JSON.");
    expect(() => parseLooseJson("no json here")).toThrow("Claude's answer was not valid JSON.");
  });
  it("strips fences and trailing prose", () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('Here you go: {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });
});

describe("isPrivateAddress IPv6 link-local", () => {
  it("covers the whole fe80::/10 block, not just fe80", () => {
    for (const ip of ["fe80::1", "fe90::1", "fea0::dead", "febf::1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["fec0::1", "fe00::1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("sniffImage", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const jpeg = (w: number, h: number) => {
    // SOI, APP0 (length 16), SOF0 (length 17) with height/width, then SOS.
    const b = Buffer.alloc(2 + 18 + 19 + 2, 0);
    let i = 0;
    b[i++] = 0xff; b[i++] = 0xd8;
    b[i++] = 0xff; b[i++] = 0xe0; b.writeUInt16BE(16, i); i += 16;
    b[i++] = 0xff; b[i++] = 0xc0; b.writeUInt16BE(17, i); b[i + 2] = 8; b.writeUInt16BE(h, i + 3); b.writeUInt16BE(w, i + 5); i += 17;
    b[i++] = 0xff; b[i++] = 0xda;
    return b;
  };
  it("reads PNG dimensions from IHDR", () => {
    expect(sniffImage(png(640, 480))).toEqual({ mediaType: "image/png", width: 640, height: 480 });
  });
  it("reads JPEG dimensions from the frame header", () => {
    expect(sniffImage(jpeg(1200, 900))).toEqual({ mediaType: "image/jpeg", width: 1200, height: 900 });
  });
  it("recognises GIF and WebP by magic bytes", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([0x10, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0])]);
    expect(sniffImage(gif)).toEqual({ mediaType: "image/gif", width: 16, height: 8 });
    const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(8)]);
    expect(sniffImage(webp)).toEqual({ mediaType: "image/webp" });
  });
  it("rejects HTML, AVIF and tiny buffers", () => {
    expect(sniffImage(Buffer.from("<!doctype html><html><body>denied</body></html>"))).toBeNull();
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif", "latin1"), Buffer.alloc(16)]);
    expect(sniffImage(avif)).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
