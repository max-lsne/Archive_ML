import { describe, expect, it } from "vitest";
import { normalizeUrl, parseHtml, scorePdfCandidate } from "../server/src/fetcher";
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

describe("scorePdfCandidate", () => {
  it("prefers manual-like names", () => {
    expect(scorePdfCandidate("https://x.com/a/pitching-guide.pdf", "")).toBeGreaterThan(scorePdfCandidate("https://x.com/a/catalogue.pdf", ""));
  });
});

describe("normalizeUrl", () => {
  it("adds https and rejects junk", () => {
    expect(normalizeUrl("ikea.com/x").toString()).toBe("https://ikea.com/x");
    expect(() => normalizeUrl("ftp://x")).toThrow();
    expect(() => normalizeUrl("not a url")).toThrow();
  });
});

describe("parseLooseJson", () => {
  it("strips fences and trailing prose", () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('Here you go: {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
  });
});
