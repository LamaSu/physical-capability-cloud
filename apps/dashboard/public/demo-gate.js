// Asks this deployment whether the pizza demo is on, and shows a notice when it is off.
(() => {
  window.pccDemoGate = (async () => {
    const tag = document.querySelector('script[src="/demo-gate.js"]');
    const param = tag && tag.getAttribute("data-base-param");
    const query = new URLSearchParams(location.search);
    const base = (param !== null && param !== undefined && query.has(param)
      ? query.get(param)
      : location.origin).trim().replace(/\/$/, "");
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("unknown");
      }, 5000);
    });
    let state;
    try {
      state = await Promise.race([
        fetch(base + "/sse/demo/firehose", {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        }).then((res) => {
          if (res.status === 404) return "off";
          if (res.status === 200 && /^text\/event-stream/i.test(res.headers.get("content-type") || "")) return "on";
          return "unknown";
        }).catch(() => "unknown"),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (state === "off") {
      if (document.readyState === "loading") {
        await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
      }
      const header = document.querySelector("body > header");
      const brand = header && Array.from(header.children).find((el) => el.classList.contains("brand"));
      if (header) {
        for (const el of Array.from(header.children)) {
          if (el !== brand) el.remove();
        }
      }
      for (const el of Array.from(document.body.children)) {
        if (el !== header && el.tagName !== "SCRIPT" && !["grid-bg", "glow", "grain"].some((name) => el.classList.contains(name))) el.remove();
      }
      const main = document.createElement("main");
      main.setAttribute("id", "demo-off");
      main.setAttribute("style", "position:relative;z-index:1;max-width:560px;margin:0 auto;padding:48px 18px");
      const title = document.createElement("h1");
      title.textContent = "The pizza demo is off on this deployment.";
      const paragraph = document.createElement("p");
      const link = document.createElement("a");
      link.setAttribute("href", "/");
      link.textContent = "Home";
      paragraph.appendChild(link);
      main.appendChild(title);
      main.appendChild(paragraph);
      if (header) header.after(main);
      else document.body.prepend(main);
    }
    return state;
  })();
})();
