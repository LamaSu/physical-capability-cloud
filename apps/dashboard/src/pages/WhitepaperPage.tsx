import React from "react";

export function WhitepaperPage() {
  const [html, setHtml] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/whitepaper.md")
      .then((r) => r.text())
      .then((md) => {
        setHtml(markdownToHtml(md));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#050a0e]">
        <div className="text-white/30 text-sm">Loading whitepaper...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050a0e] py-12 px-4">
      <article
        className="mx-auto max-w-3xl prose-pcc"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <style>{`
        .prose-pcc {
          color: rgba(255,255,255,0.75);
          font-family: "Inter", system-ui, sans-serif;
          line-height: 1.75;
        }
        .prose-pcc h1 {
          color: #6effc0;
          font-size: 2rem;
          font-weight: 700;
          margin-top: 2.5rem;
          margin-bottom: 1rem;
          line-height: 1.25;
          font-family: "Space Grotesk", "Inter", system-ui, sans-serif;
        }
        .prose-pcc h2 {
          color: #3b82f6;
          font-size: 1.4rem;
          font-weight: 600;
          margin-top: 2rem;
          margin-bottom: 0.75rem;
          padding-bottom: 0.4rem;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          font-family: "Space Grotesk", "Inter", system-ui, sans-serif;
        }
        .prose-pcc h3 {
          color: rgba(255,255,255,0.85);
          font-size: 1.15rem;
          font-weight: 600;
          margin-top: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .prose-pcc h4 {
          color: rgba(255,255,255,0.7);
          font-size: 1rem;
          font-weight: 600;
          margin-top: 1.25rem;
          margin-bottom: 0.4rem;
        }
        .prose-pcc p {
          margin-bottom: 1rem;
        }
        .prose-pcc strong {
          color: rgba(255,255,255,0.9);
          font-weight: 600;
        }
        .prose-pcc em {
          color: rgba(255,255,255,0.65);
        }
        .prose-pcc a {
          color: #00d4ff;
          text-decoration: none;
        }
        .prose-pcc a:hover {
          text-decoration: underline;
        }
        .prose-pcc code {
          background: rgba(255,255,255,0.06);
          color: #90e0ef;
          padding: 0.15em 0.35em;
          border-radius: 4px;
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: 0.88em;
        }
        .prose-pcc pre {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 1rem;
          overflow-x: auto;
          margin-bottom: 1.25rem;
        }
        .prose-pcc pre code {
          background: none;
          padding: 0;
          font-size: 0.85em;
        }
        .prose-pcc blockquote {
          border-left: 3px solid #3b82f6;
          padding-left: 1rem;
          color: rgba(255,255,255,0.55);
          margin: 1rem 0;
        }
        .prose-pcc ul, .prose-pcc ol {
          padding-left: 1.5rem;
          margin-bottom: 1rem;
        }
        .prose-pcc li {
          margin-bottom: 0.35rem;
        }
        .prose-pcc hr {
          border: none;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 2rem 0;
        }
        .prose-pcc table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 1.25rem;
          font-size: 0.9em;
        }
        .prose-pcc th {
          text-align: left;
          padding: 0.5rem 0.75rem;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.5);
          font-weight: 500;
          font-size: 0.8em;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .prose-pcc td {
          padding: 0.5rem 0.75rem;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .prose-pcc tr:hover td {
          background: rgba(255,255,255,0.02);
        }
        .prose-pcc img {
          max-width: 100%;
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}

/** Minimal markdown → HTML converter (no dependencies) */
function markdownToHtml(md: string): string {
  let html = md;

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return `<pre><code class="language-${lang}">${esc(code.trimEnd())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Tables
  html = html.replace(
    /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm,
    (_m, header: string, _sep: string, body: string) => {
      const hCells = header.split("|").filter(Boolean).map((c: string) => c.trim());
      const rows = body.trim().split("\n").filter(Boolean);
      let t = "<table><thead><tr>" + hCells.map((c: string) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      for (const row of rows) {
        const cells = row.split("|").filter(Boolean).map((c: string) => c.trim());
        t += "<tr>" + cells.map((c: string) => `<td>${c}</td>`).join("") + "</tr>";
      }
      return t + "</tbody></table>";
    },
  );

  // Headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // HR
  html = html.replace(/^---+$/gm, "<hr>");

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Unordered lists
  html = html.replace(/^(\s*)-\s+(.+)$/gm, "$1<li>$2</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Blockquotes
  html = html.replace(/^>\s*(.+)$/gm, "<blockquote>$1</blockquote>");

  // Paragraphs: wrap remaining text blocks
  html = html.replace(/^(?!<[a-z])((?!<).+)$/gm, "<p>$1</p>");

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
