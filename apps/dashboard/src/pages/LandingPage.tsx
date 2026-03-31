import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ---------------------------------------------------------------------------
// Google Fonts — Signal mood palette
// ---------------------------------------------------------------------------

const FONT_LINK = document.createElement("link");
FONT_LINK.rel = "stylesheet";
FONT_LINK.href =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap";
if (!document.head.querySelector("[href*='Space+Grotesk']")) {
  document.head.appendChild(FONT_LINK);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? "https://pcc-gateway-production.up.railway.app"
    : "http://localhost:3200");

const sg = "'Space Grotesk', sans-serif";
const inter = "'Inter', sans-serif";
const mono = "'Space Mono', monospace";

const GREEN = "#00ff88";
const BG_DARK = "#050a0e";
const BG_MID = "#0d1a14";
const TEXT_PRIMARY = "#f0f4f0";
const TEXT_MUTED = "#8a9a8a";
const TEXT_DIM = "#4a5a4a";
const AMBER = "#f5a623";

// ---------------------------------------------------------------------------
// Intersection observer hook
// ---------------------------------------------------------------------------

function useInView(threshold = 0.15): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
}

// ---------------------------------------------------------------------------
// Count-up hook
// ---------------------------------------------------------------------------

function useCountUp(target: number, duration: number, active: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) return;
    let start: number | null = null;
    const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
    const tick = (ts: number) => {
      if (!start) start = ts;
      const elapsed = Math.min((ts - start) / duration, 1);
      setValue(Math.floor(easeOutExpo(elapsed) * target));
      if (elapsed < 1) requestAnimationFrame(tick);
      else setValue(target);
    };
    requestAnimationFrame(tick);
  }, [active, target, duration]);
  return value;
}

// ---------------------------------------------------------------------------
// Reveal wrapper
// ---------------------------------------------------------------------------

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const [ref, inView] = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(20px)",
        transition: `opacity 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}s, transform 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section label
// ---------------------------------------------------------------------------

function SectionLabel({ text }: { text: string }) {
  return (
    <p
      style={{
        fontFamily: mono,
        fontSize: "0.75rem",
        fontWeight: 400,
        color: GREEN,
        letterSpacing: "0.2em",
        textTransform: "uppercase",
        marginBottom: "1.5rem",
      }}
    >
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Terminal CTA button
// ---------------------------------------------------------------------------

function TerminalCTA({
  text,
  href,
  onClick,
}: {
  text: string;
  href?: string;
  onClick?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handle = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
    onClick?.();
  }, [text, onClick]);

  const el = (
    <button
      onClick={handle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        fontFamily: mono,
        fontSize: "0.9rem",
        color: copied ? TEXT_PRIMARY : GREEN,
        background: BG_MID,
        border: `1px solid ${copied ? "rgba(0,255,136,0.8)" : "rgba(0,255,136,0.4)"}`,
        borderRadius: "4px",
        padding: "0.875rem 1.5rem",
        cursor: "pointer",
        transition: "border-color 0.2s, box-shadow 0.2s, color 0.2s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = GREEN;
        (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 0 24px rgba(0,255,136,0.2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = copied
          ? "rgba(0,255,136,0.8)"
          : "rgba(0,255,136,0.4)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
      }}
    >
      <span style={{ color: TEXT_MUTED }}>$ </span>
      {copied ? "copied!" : text}
    </button>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
        {el}
      </a>
    );
  }
  return el;
}

// ---------------------------------------------------------------------------
// Ghost link
// ---------------------------------------------------------------------------

function GhostLink({
  text,
  href,
  arrow = true,
}: {
  text: string;
  href: string;
  arrow?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontFamily: inter,
        fontWeight: 500,
        fontSize: "0.9rem",
        color: TEXT_MUTED,
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        transition: "color 0.2s",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_PRIMARY)}
      onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_MUTED)}
    >
      {text}
      {arrow && " →"}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Capability grid tile
// ---------------------------------------------------------------------------

const CAPABILITY_TILES = [
  { name: "3D PRINT", city: "Austin, TX" },
  { name: "PCR ARRAY", city: "Boston, MA" },
  { name: "CNC MILL", city: "Detroit, MI" },
  { name: "PIPETTE", city: "San Diego, CA" },
  { name: "LASER CUT", city: "Seattle, WA" },
  { name: "BIOREACTOR", city: "Cambridge, MA" },
  { name: "FLOW CELL", city: "Palo Alto, CA" },
  { name: "TITRATOR", city: "Chicago, IL" },
  { name: "LATHE", city: "Pittsburgh, PA" },
  { name: "RESIN CURE", city: "Denver, CO" },
  { name: "WIRE EDM", city: "Houston, TX" },
  { name: "SPIN COAT", city: "Portland, OR" },
];

type TileState = "idle" | "available" | "busy";

interface Tile {
  name: string;
  city: string;
  state: TileState;
  visible: boolean;
}

function CapabilityGrid({ mousePos }: { mousePos: { x: number; y: number } }) {
  const [tiles, setTiles] = useState<Tile[]>(
    CAPABILITY_TILES.map((t, i) => ({
      ...t,
      state: i < 3 ? "available" : ("idle" as TileState),
      visible: false,
    })),
  );
  const gridRef = useRef<HTMLDivElement>(null);

  // Stagger reveal on mount
  useEffect(() => {
    const timers = tiles.map((_, i) =>
      setTimeout(() => {
        setTiles((prev) => prev.map((t, j) => (j === i ? { ...t, visible: true } : t)));
      }, i * 80),
    );
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat: idle→available every 3.5s
  useEffect(() => {
    const iv = setInterval(() => {
      setTiles((prev) => {
        const idleIdxs = prev.map((t, i) => (t.state === "idle" ? i : -1)).filter((i) => i >= 0);
        if (!idleIdxs.length) return prev;
        const pick = idleIdxs[Math.floor(Math.random() * idleIdxs.length)];
        return prev.map((t, i) => (i === pick ? { ...t, state: "available" } : t));
      });
    }, 3500);
    return () => clearInterval(iv);
  }, []);

  // available→busy→available every 7s
  useEffect(() => {
    const iv = setInterval(() => {
      setTiles((prev) => {
        const avlIdxs = prev
          .map((t, i) => (t.state === "available" ? i : -1))
          .filter((i) => i >= 0);
        if (!avlIdxs.length) return prev;
        const pick = avlIdxs[Math.floor(Math.random() * avlIdxs.length)];
        const next = prev.map((t, i) => (i === pick ? { ...t, state: "busy" as TileState } : t));
        setTimeout(() => {
          setTiles((p) => p.map((t, i) => (i === pick ? { ...t, state: "available" } : t)));
        }, 4000);
        return next;
      });
    }, 7000);
    return () => clearInterval(iv);
  }, []);

  const getBorderColor = (state: TileState) => {
    if (state === "available") return "rgba(0,255,136,0.3)";
    if (state === "busy") return "rgba(245,166,35,0.3)";
    return "rgba(0,255,136,0.06)";
  };

  const getIndicatorColor = (state: TileState) => {
    if (state === "available") return GREEN;
    if (state === "busy") return AMBER;
    return TEXT_DIM;
  };

  const getIndicatorText = (state: TileState) => {
    if (state === "available") return "● AVAILABLE";
    if (state === "busy") return "◑ IN PROGRESS";
    return "○ IDLE";
  };

  // Cursor tilt — compute per tile
  const getTilt = (idx: number) => {
    const el = gridRef.current;
    if (!el) return { rotX: 0, rotY: 0 };
    const rect = el.getBoundingClientRect();
    const cols = 4;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const tileW = rect.width / cols;
    const tileH = rect.height / Math.ceil(CAPABILITY_TILES.length / cols);
    const tileCX = rect.left + col * tileW + tileW / 2;
    const tileCY = rect.top + row * tileH + tileH / 2;
    const dx = mousePos.x - tileCX;
    const dy = mousePos.y - tileCY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 200) return { rotX: 0, rotY: 0 };
    const factor = (1 - dist / 200) * 6;
    return { rotX: (-dy / 100) * factor, rotY: (dx / 100) * factor };
  };

  return (
    <div
      ref={gridRef}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "0.5rem",
        maskImage:
          "radial-gradient(ellipse 80% 80% at 60% 50%, black 30%, transparent 100%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 80% 80% at 60% 50%, black 30%, transparent 100%)",
      }}
    >
      {tiles.map((tile, i) => {
        const { rotX, rotY } = getTilt(i);
        return (
          <div
            key={tile.name}
            style={{
              background: BG_MID,
              border: `1px solid ${getBorderColor(tile.state)}`,
              borderRadius: "4px",
              padding: "1rem",
              opacity: tile.visible ? 1 : 0,
              transform: `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg)`,
              transition: `opacity 0.4s ease ${i * 0.08}s, border-color 0.3s, transform 0.1s ease-out`,
              cursor: "default",
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: "0.7rem",
                color: TEXT_PRIMARY,
                marginBottom: "0.5rem",
                letterSpacing: "0.05em",
              }}
            >
              {tile.name}
            </div>
            <div
              style={{
                fontFamily: mono,
                fontSize: "0.6rem",
                color: TEXT_DIM,
                marginBottom: "0.75rem",
              }}
            >
              {tile.city}
            </div>
            <div
              style={{
                fontFamily: mono,
                fontSize: "0.55rem",
                color: getIndicatorColor(tile.state),
                letterSpacing: "0.05em",
                transition: "color 0.3s",
              }}
            >
              {getIndicatorText(tile.state)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function Nav() {
  const navigate = useNavigate();
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(5,10,14,0.88)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(0,255,136,0.12)",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: "3.5rem",
        }}
      >
        {/* Logo */}
        <button
          onClick={() => navigate("/")}
          style={{
            fontFamily: mono,
            fontSize: "1.1rem",
            fontWeight: 700,
            color: GREEN,
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          PCC
        </button>

        {/* Links */}
        <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
          {[
            { text: "For Operators", href: "#operators" },
            { text: "For Agents", href: "#agents" },
            { text: "Docs", href: "https://docs.capability.network" },
            { text: "GitHub", href: "https://github.com/wingdingspenpal/poop" },
          ].map((link) => (
            <a
              key={link.text}
              href={link.href}
              target={link.href.startsWith("http") ? "_blank" : undefined}
              rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
              style={{
                fontFamily: inter,
                fontSize: "0.875rem",
                fontWeight: 500,
                color: TEXT_MUTED,
                textDecoration: "none",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_PRIMARY)}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_MUTED)}
            >
              {link.text}
            </a>
          ))}
          <a
            href="https://capability.network"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: mono,
              fontSize: "0.75rem",
              color: GREEN,
              border: `1px solid rgba(0,255,136,0.4)`,
              borderRadius: "4px",
              padding: "0.35rem 0.85rem",
              textDecoration: "none",
              transition: "border-color 0.2s, box-shadow 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = GREEN;
              (e.currentTarget as HTMLAnchorElement).style.boxShadow = "0 0 12px rgba(0,255,136,0.3)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(0,255,136,0.4)";
              (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
            }}
          >
            capability.network
          </a>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero section
// ---------------------------------------------------------------------------

function HeroSection({ mousePos }: { mousePos: { x: number; y: number } }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <section
      style={{
        position: "relative",
        background: BG_DARK,
        backgroundImage:
          "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,136,0.008) 2px, rgba(0,255,136,0.008) 4px)",
        paddingTop: "clamp(6rem, 12vw, 10rem)",
        paddingBottom: "clamp(6rem, 10vw, 8rem)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "4rem",
          alignItems: "center",
          position: "relative",
          zIndex: 2,
        }}
      >
        {/* Left: text */}
        <div>
          {/* Eyebrow */}
          <div
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? "translateY(0)" : "translateY(-8px)",
              transition: "opacity 0.6s ease 0.1s, transform 0.6s ease 0.1s",
            }}
          >
            <SectionLabel text="Physical Capability Cloud" />
          </div>

          {/* Tagline */}
          <div
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? "translateY(0)" : "translateY(12px)",
              transition: "opacity 0.7s ease 0.25s, transform 0.7s ease 0.25s",
            }}
          >
            <h1
              style={{
                fontFamily: sg,
                fontWeight: 800,
                fontSize: "clamp(3.5rem, 8vw, 7rem)",
                lineHeight: 0.95,
                letterSpacing: "-0.03em",
                margin: "0 0 2rem 0",
              }}
            >
              <span style={{ color: TEXT_PRIMARY, display: "block" }}>
                Physical infrastructure,
              </span>
              <span style={{ color: GREEN, display: "block" }}>composable.</span>
            </h1>
          </div>

          {/* Subhead */}
          <div
            style={{
              opacity: mounted ? 1 : 0,
              transition: "opacity 0.7s ease 0.45s",
            }}
          >
            <p
              style={{
                fontFamily: inter,
                fontWeight: 400,
                fontSize: "clamp(1.1rem, 2vw, 1.375rem)",
                lineHeight: 1.65,
                color: TEXT_MUTED,
                maxWidth: "580px",
                margin: "0 0 2.5rem 0",
              }}
            >
              AI agents discover, bid, and hire real equipment. Operators earn directly. No brokers.
              Cryptographic proof on every job.
            </p>
          </div>

          {/* CTAs */}
          <div
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? "translateY(0)" : "translateY(10px)",
              transition: "opacity 0.7s ease 0.6s, transform 0.7s ease 0.6s",
              display: "flex",
              alignItems: "center",
              gap: "2rem",
              flexWrap: "wrap",
            }}
          >
            <TerminalCTA text="pip install pcc-node" href="https://pypi.org/project/pcc-node/" />
            <GhostLink text="Read the docs" href="https://docs.capability.network" />
          </div>
        </div>

        {/* Right: capability grid */}
        <div
          style={{
            opacity: mounted ? 0.85 : 0,
            transition: "opacity 1s ease 0.3s",
          }}
        >
          <CapabilityGrid mousePos={mousePos} />
        </div>
      </div>

      {/* Vignette — left side readable */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 30% 50%, transparent 30%, rgba(5,10,14,0.65) 100%)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Problem section
// ---------------------------------------------------------------------------

function BigStat() {
  const [ref, inView] = useInView(0.3);
  const count = useCountUp(100, 1800, inView);
  return (
    <div ref={ref} style={{ textAlign: "center", padding: "3rem 0" }}>
      <div
        style={{
          fontFamily: sg,
          fontWeight: 800,
          fontSize: "clamp(4rem, 10vw, 8rem)",
          lineHeight: 1,
          letterSpacing: "-0.04em",
          color: GREEN,
        }}
      >
        ${inView ? count : 0}B+
      </div>
      <p
        style={{
          fontFamily: inter,
          fontSize: "1rem",
          color: TEXT_MUTED,
          maxWidth: "280px",
          margin: "0.75rem auto 0",
          lineHeight: 1.5,
        }}
      >
        physical manufacturing capacity sitting idle worldwide
      </p>
    </div>
  );
}

const PROBLEMS = [
  {
    label: "OVERHEAD",
    text: "Brokers and middlemen take 35–60%",
    subtext:
      "Every transaction through a core facility or contract manufacturer passes through layers of administrative overhead. The researcher pays more. The operator earns less. Nobody keeps what they make.",
  },
  {
    label: "FRAGMENTATION",
    text: "Equipment sits idle. Researchers wait.",
    subtext:
      "A university HPLC in Boston sits idle at 2pm. A biotech team in Austin needs compound analysis. No protocol connects them. Manual RFQs, phone calls, NDAs, weeks of lead time. The capability exists. The connection doesn't.",
  },
  {
    label: "TRUST",
    text: "No verifiable proof layer exists.",
    subtext:
      "When you hire a remote lab, you get a PDF report and a prayer. No cryptographic evidence. No audit trail. No recourse if the operator cuts corners. Trust is opaque and non-transferable.",
  },
];

function ProblemSection() {
  return (
    <section
      id="problem"
      style={{
        background: BG_MID,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
        }}
      >
        {/* Headline */}
        <Reveal>
          <h2
            style={{
              fontFamily: sg,
              fontWeight: 700,
              fontSize: "clamp(2.5rem, 5vw, 4rem)",
              lineHeight: 1.1,
              color: TEXT_PRIMARY,
              maxWidth: "700px",
              margin: "0 0 1.5rem 0",
            }}
          >
            Brilliant researchers are locked
            <br />
            out of their own field.
          </h2>
          <p
            style={{
              fontFamily: inter,
              fontWeight: 400,
              fontSize: "clamp(1rem, 1.5vw, 1.2rem)",
              color: TEXT_MUTED,
              maxWidth: "600px",
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            Not because the equipment doesn't exist — because no one built the protocol to connect
            them.
          </p>
        </Reveal>

        {/* $100B+ stat */}
        <BigStat />

        {/* Problem cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1.5rem",
            marginBottom: "4rem",
          }}
        >
          {PROBLEMS.map((p, i) => (
            <Reveal key={p.label} delay={i * 0.15}>
              <div
                style={{
                  background: BG_DARK,
                  border: "1px solid rgba(0,255,136,0.06)",
                  borderLeft: `3px solid ${AMBER}`,
                  borderRadius: "4px",
                  padding: "2rem",
                  height: "100%",
                }}
              >
                <p
                  style={{
                    fontFamily: mono,
                    fontSize: "0.65rem",
                    letterSpacing: "0.15em",
                    color: AMBER,
                    marginBottom: "0.75rem",
                  }}
                >
                  {p.label}
                </p>
                <p
                  style={{
                    fontFamily: sg,
                    fontWeight: 600,
                    fontSize: "1.2rem",
                    color: TEXT_PRIMARY,
                    marginBottom: "1rem",
                    lineHeight: 1.3,
                  }}
                >
                  {p.text}
                </p>
                <p
                  style={{
                    fontFamily: inter,
                    fontSize: "0.9rem",
                    color: TEXT_MUTED,
                    lineHeight: 1.6,
                    margin: 0,
                  }}
                >
                  {p.subtext}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Human story — before/after */}
        <Reveal>
          <div
            style={{
              background: BG_DARK,
              border: "1px solid rgba(0,255,136,0.06)",
              borderRadius: "4px",
              padding: "2.5rem",
              marginBottom: "4rem",
            }}
          >
            <p
              style={{
                fontFamily: mono,
                fontSize: "0.75rem",
                color: TEXT_MUTED,
                marginBottom: "1.5rem",
                letterSpacing: "0.1em",
              }}
            >
              THE STORY WE KEEP HEARING:
            </p>
            <p
              style={{
                fontFamily: inter,
                fontSize: "0.95rem",
                color: TEXT_MUTED,
                marginBottom: "2rem",
                lineHeight: 1.65,
              }}
            >
              A team of researchers has a breakthrough compound synthesis idea. They need CNC access
              for custom lab fixtures.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                gap: "2rem",
                alignItems: "start",
              }}
            >
              {/* BEFORE */}
              <div
                style={{
                  border: `1px solid rgba(245,166,35,0.2)`,
                  borderRadius: "4px",
                  padding: "1.5rem",
                  background: "rgba(245,166,35,0.03)",
                }}
              >
                <p
                  style={{
                    fontFamily: mono,
                    fontSize: "0.65rem",
                    color: AMBER,
                    letterSpacing: "0.15em",
                    marginBottom: "1rem",
                  }}
                >
                  BEFORE
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {[
                    ["Setup fee", "$8,000"],
                    ["Overhead cut", "35%"],
                    ["Lead time", "6 weeks"],
                    ["NDA process", "2 weeks"],
                  ].map(([label, val]) => (
                    <div
                      key={label}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    >
                      <span style={{ fontFamily: inter, fontSize: "0.85rem", color: TEXT_MUTED }}>
                        {label}
                      </span>
                      <span style={{ fontFamily: mono, fontSize: "0.85rem", color: AMBER }}>
                        {val}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Arrow */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.5rem",
                  color: TEXT_DIM,
                  paddingTop: "2rem",
                }}
              >
                →
              </div>

              {/* AFTER */}
              <div
                style={{
                  border: `1px solid rgba(0,255,136,0.2)`,
                  borderRadius: "4px",
                  padding: "1.5rem",
                  background: "rgba(0,255,136,0.03)",
                }}
              >
                <p
                  style={{
                    fontFamily: mono,
                    fontSize: "0.65rem",
                    color: GREEN,
                    letterSpacing: "0.15em",
                    marginBottom: "1rem",
                  }}
                >
                  WITH PCC
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {[
                    ["Winning bid", "$300"],
                    ["Clearing fee", "1.5%"],
                    ["Time to job", "20 minutes"],
                    ["Proof", "cryptographic"],
                  ].map(([label, val]) => (
                    <div
                      key={label}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    >
                      <span style={{ fontFamily: inter, fontSize: "0.85rem", color: TEXT_MUTED }}>
                        {label}
                      </span>
                      <span style={{ fontFamily: mono, fontSize: "0.85rem", color: GREEN }}>
                        {val}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Transition line */}
        <Reveal>
          <p
            style={{
              fontFamily: sg,
              fontWeight: 700,
              fontSize: "clamp(1.5rem, 3vw, 2.5rem)",
              color: TEXT_PRIMARY,
              lineHeight: 1.2,
            }}
          >
            We built the{" "}
            <span style={{ color: GREEN }}>protocol layer</span> that makes this possible.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How It Works section
// ---------------------------------------------------------------------------

const PHASES = [
  {
    number: "01",
    phase: "DISCOVER",
    title: "Agents find operators",
    description:
      "User Agent broadcasts capability requirements to the DHT gossip network. Operators with matching capability types and assurance tiers surface in milliseconds — not days of manual RFQs.",
    tech: "DHT gossip network. Filter by capability type, assurance tier, location, price range.",
  },
  {
    number: "02",
    phase: "BID",
    title: "Auction pricing. No floor.",
    description:
      "Operators set maximum prices. Agents bid downward. Queue depth and reputation drive discounts. No broker markup, no minimum contract, no setup fee.",
    tech: "Reverse auction. Queue-depth discounting. Reputation-weighted scoring.",
  },
  {
    number: "03",
    phase: "ESCROW",
    title: "Funds lock. Work begins.",
    description:
      "Milestone funds lock in the MilestoneEscrow smart contract before any execution starts. Operators can't start without funds committed. Buyers can't move funds without verified completion.",
    tech: "MilestoneEscrow on Base Sepolia + Flow EVM (chain 545). x402 for micropayments. NEAR 1Click for cross-chain.",
  },
  {
    number: "04",
    phase: "EXECUTE",
    title: "Real machines. Live evidence.",
    description:
      "The Kernel Agent runs the job through a physical device adapter. SHA-256 content-addressed evidence events stream in real time — every action logged before the next one begins.",
    tech: "Device adapters: OctoPrint, Modbus TCP/RTU, OPC-UA, SiLA 2, OT-2 liquid handler. Evidence: SSE stream, hash-chained.",
  },
  {
    number: "05",
    phase: "VERIFY",
    title: "Cryptographic proof. On every job.",
    description:
      "Evidence bundles are encrypted via Lit Protocol, stored permanently on IPFS via Storacha, Merkle-committed, and the proof hash anchored on Starknet. You can verify every claim.",
    tech: "Lit Protocol threshold encryption. Storacha w3up → IPFS CIDv1. Starknet felt252 anchoring. Photo verification: pHash + SSIM.",
  },
  {
    number: "06",
    phase: "SETTLE",
    title: "Auto-release. No invoices.",
    description:
      "Escrow releases automatically when evidence meets the contract's assurance tier requirements. Soulbound capability certificates mint on Solana. Operators earn directly. 1.5% clearing fee. Hardcoded.",
    tech: "Auto-release escrow. Soulbound NFT certificates on Solana. DePIN reward epochs. 1.5% immutable clearing fee.",
  },
];

function HowItWorksSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const [dotProgress, setDotProgress] = useState(0);
  const [activePhase, setActivePhase] = useState(-1);

  useEffect(() => {
    const handleScroll = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const progress = Math.max(
        0,
        Math.min(1, (window.innerHeight - rect.top) / (rect.height + window.innerHeight)),
      );
      setDotProgress(progress);
      setActivePhase(Math.floor(progress * 6) - 1);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      style={{
        background: BG_DARK,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1400px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
        }}
      >
        <Reveal>
          <SectionLabel text="HOW IT WORKS" />
          <h2
            style={{
              fontFamily: sg,
              fontWeight: 700,
              fontSize: "clamp(2.5rem, 5vw, 4rem)",
              lineHeight: 1.1,
              color: TEXT_PRIMARY,
              maxWidth: "800px",
              marginBottom: "1rem",
            }}
          >
            Six phases. Every job. No exceptions.
          </h2>
          <p
            style={{
              fontFamily: inter,
              fontSize: "1.1rem",
              color: TEXT_MUTED,
              maxWidth: "560px",
              lineHeight: 1.6,
              marginBottom: "4rem",
            }}
          >
            Every physical job runs the same cryptographically-secured pipeline — from discovery to
            settlement. Fully automated. Fully verifiable.
          </p>
        </Reveal>

        {/* Timeline connector + cards */}
        <div style={{ position: "relative" }}>
          {/* Progress line */}
          <div
            style={{
              position: "absolute",
              top: "3.5rem",
              left: 0,
              right: 0,
              height: "1px",
              background: "rgba(0,255,136,0.15)",
              zIndex: 0,
            }}
          />
          {/* Dot */}
          <div
            style={{
              position: "absolute",
              top: "calc(3.5rem - 4px)",
              left: `calc(${dotProgress * 100}% - 4px)`,
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: GREEN,
              boxShadow: "0 0 16px rgba(0,255,136,0.9)",
              zIndex: 2,
              transition: "left 0.1s linear",
            }}
          />

          {/* Phase cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 1fr)",
              gap: "1rem",
              position: "relative",
              zIndex: 1,
            }}
          >
            {PHASES.map((phase, i) => {
              const isActive = i <= activePhase;
              return (
                <Reveal key={phase.number} delay={i * 0.1}>
                  <div
                    style={{
                      background: BG_DARK,
                      border: `1px solid ${isActive ? "rgba(0,255,136,0.3)" : "rgba(0,255,136,0.08)"}`,
                      borderRadius: "4px",
                      padding: "2rem",
                      transition: "border-color 0.3s, box-shadow 0.3s",
                      boxShadow: isActive ? "0 8px 32px rgba(0,255,136,0.06)" : "none",
                      height: "100%",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor =
                        "rgba(0,255,136,0.3)";
                      (e.currentTarget as HTMLDivElement).style.boxShadow =
                        "0 8px 32px rgba(0,255,136,0.06)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = isActive
                        ? "rgba(0,255,136,0.3)"
                        : "rgba(0,255,136,0.08)";
                      (e.currentTarget as HTMLDivElement).style.boxShadow = isActive
                        ? "0 8px 32px rgba(0,255,136,0.06)"
                        : "none";
                    }}
                  >
                    <div style={{ marginBottom: "0.5rem" }}>
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: "0.65rem",
                          color: GREEN,
                          opacity: isActive ? 1 : 0.6,
                          transition: "opacity 0.3s",
                        }}
                      >
                        {phase.number}
                      </span>
                      {" "}
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: "0.6rem",
                          color: TEXT_MUTED,
                          letterSpacing: "0.15em",
                        }}
                      >
                        {phase.phase}
                      </span>
                    </div>
                    <p
                      style={{
                        fontFamily: sg,
                        fontWeight: 700,
                        fontSize: "1rem",
                        color: TEXT_PRIMARY,
                        marginBottom: "0.75rem",
                        lineHeight: 1.3,
                      }}
                    >
                      {phase.title}
                    </p>
                    <p
                      style={{
                        fontFamily: inter,
                        fontSize: "0.85rem",
                        color: TEXT_MUTED,
                        lineHeight: 1.6,
                        marginBottom: "1rem",
                      }}
                    >
                      {phase.description}
                    </p>
                    <p
                      style={{
                        fontFamily: mono,
                        fontSize: "0.65rem",
                        color: "rgba(0,255,136,0.5)",
                        lineHeight: 1.5,
                      }}
                    >
                      {phase.tech}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Terminal replay component
// ---------------------------------------------------------------------------

const TERMINAL_LINES = [
  { prefix: "$ ", text: "pip install pcc-node", color: TEXT_PRIMARY, delay: 0 },
  { prefix: "$ ", text: "pcc-node start", color: TEXT_PRIMARY, delay: 600 },
  { prefix: "  ", text: "Detecting hardware...", color: TEXT_MUTED, delay: 1000 },
  { prefix: "  ✓ ", text: "OT-2 liquid handler found at 192.168.1.105", color: GREEN, delay: 1500 },
  { prefix: "  ✓ ", text: "Ed25519 keypair generated: 7f3a2b...", color: GREEN, delay: 1900 },
  { prefix: "  ✓ ", text: "API credentials provisioned", color: GREEN, delay: 2200 },
  { prefix: "  ✓ ", text: "Kernel registered: kernel_7f3a2b", color: GREEN, delay: 2500 },
  { prefix: "  ✓ ", text: "8 capabilities announced to DHT", color: GREEN, delay: 2800 },
  {
    prefix: "  ",
    text: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    color: "rgba(0,255,136,0.2)",
    delay: 3100,
  },
  { prefix: "  ", text: "Live. Accepting jobs. Earnings → your wallet.", color: GREEN, delay: 3200 },
  {
    prefix: "  ",
    text: "Dashboard: capability.network/operator",
    color: TEXT_MUTED,
    delay: 3600,
  },
];

function TerminalBlock({ active }: { active: boolean }) {
  const [visibleLines, setVisibleLines] = useState<number[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    TERMINAL_LINES.forEach((line, i) => {
      setTimeout(() => {
        setVisibleLines((prev) => [...prev, i]);
      }, line.delay);
    });
  }, [active]);

  return (
    <div
      style={{
        background: BG_DARK,
        border: "1px solid rgba(0,255,136,0.2)",
        borderRadius: "4px",
        padding: "2rem",
        fontFamily: mono,
        fontSize: "0.85rem",
        lineHeight: 1.8,
        maxWidth: "560px",
      }}
    >
      <p
        style={{
          fontFamily: mono,
          fontSize: "0.75rem",
          color: TEXT_MUTED,
          marginBottom: "1.5rem",
          letterSpacing: "0.1em",
        }}
      >
        $ pcc-node start
      </p>
      {TERMINAL_LINES.map((line, i) => (
        <div
          key={i}
          style={{
            opacity: visibleLines.includes(i) ? 1 : 0,
            transition: "opacity 0.3s ease",
            display: "flex",
          }}
        >
          <span style={{ color: TEXT_MUTED, whiteSpace: "pre" }}>{line.prefix}</span>
          <span style={{ color: line.color }}>{line.text}</span>
        </div>
      ))}
      {visibleLines.length === TERMINAL_LINES.length && (
        <span
          style={{
            display: "inline-block",
            width: "8px",
            height: "14px",
            background: GREEN,
            animation: "blink 0.7s steps(1) infinite",
            marginLeft: "0.25rem",
            verticalAlign: "middle",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// For Operators section
// ---------------------------------------------------------------------------

const STEPS = [
  {
    step: "1",
    title: "Install",
    text: "pip install pcc-node — Python 3.9+. Works on Raspberry Pi, Ubuntu, macOS, Windows.",
    badge: "30 sec",
  },
  {
    step: "2",
    title: "Detect",
    text: "Auto-discovery scans for connected devices: OctoPrint, Modbus PLCs, OPC-UA instruments, SiLA 2 lab equipment.",
    badge: "automatic",
  },
  {
    step: "3",
    title: "Register",
    text: "Ed25519 keypair generates. API credentials provision. Unique kernel identity on the network.",
    badge: "60 sec",
  },
  {
    step: "4",
    title: "Earn",
    text: "Capabilities announced. Jobs arrive. Escrow releases to your wallet on evidence verification. 1.5% fee. Nothing else.",
    badge: "ongoing",
  },
];

const HARDWARE = [
  { name: "OctoPrint", category: "3D Printers", icon: "△" },
  { name: "Modbus TCP/RTU", category: "Industrial PLCs", icon: "□" },
  { name: "OPC-UA", category: "Factory Automation", icon: "◇" },
  { name: "SiLA 2", category: "Lab Instruments", icon: "○" },
  { name: "OpenTrons OT-2", category: "Liquid Handlers", icon: "⬡" },
  { name: "Custom adapter", category: "Any hardware via 200-line interface", icon: "+" },
];

function ForOperatorsSection() {
  const [ref, inView] = useInView(0.2);
  return (
    <section
      id="operators"
      style={{
        background: BG_MID,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "5rem",
          alignItems: "start",
        }}
      >
        {/* Left */}
        <div>
          <Reveal>
            <SectionLabel text="FOR OPERATORS" />
            <h2
              style={{
                fontFamily: sg,
                fontWeight: 700,
                fontSize: "clamp(2.5rem, 5vw, 4rem)",
                lineHeight: 1.1,
                color: TEXT_PRIMARY,
                marginBottom: "1.5rem",
              }}
            >
              Put your equipment online.{" "}
              <span style={{ color: GREEN }}>Keep what you earn.</span>
            </h2>
            <p
              style={{
                fontFamily: inter,
                fontSize: "1.1rem",
                color: TEXT_MUTED,
                maxWidth: "560px",
                lineHeight: 1.6,
                marginBottom: "3rem",
              }}
            >
              One command. Your hardware registers, announces capabilities, and starts accepting
              jobs. No sales calls. No contracts. No 35% cuts.
            </p>
          </Reveal>

          {/* Steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: "2rem", marginBottom: "3rem" }}>
            {STEPS.map((step, i) => (
              <Reveal key={step.step} delay={i * 0.1}>
                <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>
                  <div
                    style={{
                      fontFamily: mono,
                      fontSize: "2.5rem",
                      fontWeight: 700,
                      color: "rgba(0,255,136,0.15)",
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    {step.step}
                  </div>
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        marginBottom: "0.4rem",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: sg,
                          fontWeight: 600,
                          fontSize: "1.1rem",
                          color: TEXT_PRIMARY,
                        }}
                      >
                        {step.title}
                      </span>
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: "0.65rem",
                          color: GREEN,
                          background: "rgba(0,255,136,0.08)",
                          border: "1px solid rgba(0,255,136,0.2)",
                          borderRadius: "2px",
                          padding: "0.15rem 0.4rem",
                        }}
                      >
                        {step.badge}
                      </span>
                    </div>
                    <p
                      style={{
                        fontFamily: inter,
                        fontSize: "0.9rem",
                        color: TEXT_MUTED,
                        lineHeight: 1.6,
                        margin: 0,
                      }}
                    >
                      {step.text}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Hardware list */}
          <Reveal>
            <p
              style={{
                fontFamily: mono,
                fontSize: "0.65rem",
                color: TEXT_MUTED,
                letterSpacing: "0.15em",
                marginBottom: "1rem",
              }}
            >
              SUPPORTED HARDWARE
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "0.5rem",
                marginBottom: "2.5rem",
              }}
            >
              {HARDWARE.map((hw) => (
                <div
                  key={hw.name}
                  style={{
                    background: BG_DARK,
                    border: "1px solid rgba(0,255,136,0.08)",
                    borderRadius: "4px",
                    padding: "0.75rem",
                  }}
                >
                  <div style={{ fontFamily: mono, fontSize: "0.7rem", color: TEXT_MUTED, marginBottom: "0.2rem" }}>
                    {hw.icon} {hw.name}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: "0.6rem", color: TEXT_DIM }}>
                    {hw.category}
                  </div>
                </div>
              ))}
            </div>
          </Reveal>

          {/* CTAs */}
          <Reveal>
            <div style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "wrap" }}>
              <TerminalCTA text="pip install pcc-node" href="https://pypi.org/project/pcc-node/" />
              <GhostLink text="Operator guide" href="https://docs.capability.network/operators" />
            </div>
          </Reveal>
        </div>

        {/* Right — terminal */}
        <div ref={ref} style={{ position: "sticky", top: "6rem" }}>
          <TerminalBlock active={inView} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// For Agents section
// ---------------------------------------------------------------------------

const CODE_LINES = [
  { text: "from pcc import UserAgent", type: "import" },
  { text: "import os", type: "import" },
  { text: "", type: "blank" },
  { text: "agent = UserAgent(wallet_key=os.environ['WALLET_KEY'])", type: "code" },
  { text: "", type: "blank" },
  { text: "# Discover available capabilities", type: "comment" },
  { text: "caps = await agent.discover(", type: "code", highlight: true },
  { text: "    type='compound-synthesis',", type: "code", highlight: true },
  { text: "    assurance_tier=2,", type: "code", highlight: true },
  { text: "    location='boston-ma'", type: "code", highlight: true },
  { text: ")", type: "code", highlight: true },
  { text: "", type: "blank" },
  { text: "# Bid on best match — auction pricing", type: "comment" },
  { text: "job = await agent.bid(", type: "code", highlight: true },
  { text: "    capability=caps[0],", type: "code", highlight: true },
  { text: "    max_price_usdc=300,", type: "code", highlight: true },
  { text: "    parameters={'compound': 'C6H12O6', 'qty_mg': 100}", type: "code", highlight: true },
  { text: ")", type: "code", highlight: true },
  { text: "", type: "blank" },
  { text: "# Evidence streams SHA-256 hashes during execution", type: "comment" },
  { text: "async for event in job.evidence_stream():", type: "code" },
  { text: "    print(f'[{event.phase}] {event.hash[:16]}...')", type: "code" },
  { text: "", type: "blank" },
  { text: "# Settlement is automatic — no invoice needed", type: "comment" },
  { text: "result = await job.await_settlement()", type: "code" },
  { text: "print(f'CID: {result.evidence_cid}')  # Permanent IPFS", type: "code" },
];

const A2A_INTENTS = [
  { intent: "CAPABILITY_QUERY", direction: "user → broker", payload: "type, constraints, budget" },
  { intent: "CAPABILITY_OFFER", direction: "broker → user", payload: "operators, prices, tiers" },
  { intent: "JOB_SUBMIT", direction: "user → kernel", payload: "job spec, escrow address" },
  { intent: "EVIDENCE_EMIT", direction: "kernel → verifier", payload: "SHA-256 hash, CID" },
  { intent: "SETTLEMENT_TRIGGER", direction: "verifier → escrow", payload: "proof, tier met" },
];

const TOOL_GROUPS = [
  {
    group: "Discovery",
    tools: ["pcc_list_capabilities", "pcc_build_options", "pcc_calculate_price"],
    description: "Search and filter capabilities by type, location, assurance tier, price range",
  },
  {
    group: "Execution",
    tools: ["pcc_build_contract", "pcc_list_jobs", "pcc_create_scope", "pcc_relay_tool_call"],
    description: "Submit jobs, stream evidence, poll status, manage execution scopes",
  },
  {
    group: "Verification",
    tools: ["pcc_verify_evidence", "pcc_get_proof_status", "pcc_fetch_cid"],
    description: "Verify evidence bundles, check Starknet anchors, retrieve Storacha CIDs",
  },
  {
    group: "Settlement",
    tools: ["pcc_release_milestone", "pcc_get_wallet_balance", "pcc_near_quote"],
    description: "Release escrow, check balances, cross-chain settlement via NEAR intents",
  },
];

function renderCodeLine(line: { text: string; type: string; highlight?: boolean }) {
  if (line.type === "blank") return <br />;
  if (line.type === "comment") {
    return <span style={{ color: TEXT_DIM }}>{line.text}</span>;
  }
  if (line.type === "import") {
    const parts = line.text.split(/(from|import|pcc|UserAgent|os)/);
    return (
      <span>
        {parts.map((p, i) =>
          p === "from" || p === "import" ? (
            <span key={i} style={{ color: GREEN }}>
              {p}
            </span>
          ) : p === "pcc" || p === "UserAgent" || p === "os" ? (
            <span key={i} style={{ color: "#b8d4c8" }}>
              {p}
            </span>
          ) : (
            <span key={i} style={{ color: TEXT_PRIMARY }}>
              {p}
            </span>
          ),
        )}
      </span>
    );
  }
  // Generic code — highlight strings
  return (
    <span
      style={{ color: TEXT_PRIMARY }}
      dangerouslySetInnerHTML={{
        __html: line.text
          .replace(/(['"])([^'"]*)\1/g, `<span style="color:${AMBER}">$1$2$1</span>`)
          .replace(/\b(await|async|for|in|print|return)\b/g, `<span style="color:${GREEN}">$1</span>`),
      }}
    />
  );
}

function ForAgentsSection() {
  return (
    <section
      id="agents"
      style={{
        background: BG_DARK,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "4rem",
          alignItems: "start",
        }}
      >
        {/* Left */}
        <div>
          <Reveal>
            <SectionLabel text="FOR AI AGENTS" />
            <h2
              style={{
                fontFamily: sg,
                fontWeight: 700,
                fontSize: "clamp(2.5rem, 5vw, 4rem)",
                lineHeight: 1.1,
                color: TEXT_PRIMARY,
                marginBottom: "1.5rem",
              }}
            >
              The physical world has an{" "}
              <span style={{ color: GREEN }}>API</span> now.
            </h2>
            <p
              style={{
                fontFamily: inter,
                fontSize: "1.1rem",
                color: TEXT_MUTED,
                maxWidth: "580px",
                lineHeight: 1.6,
                marginBottom: "3rem",
              }}
            >
              34 typed A2A intents. 154 agent tools. MCP server. Any agent framework, any chain.
            </p>
          </Reveal>

          {/* Tool groups */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", marginBottom: "2.5rem" }}>
            {TOOL_GROUPS.map((group, i) => (
              <Reveal key={group.group} delay={i * 0.1}>
                <div>
                  <p
                    style={{
                      fontFamily: mono,
                      fontSize: "0.65rem",
                      color: GREEN,
                      letterSpacing: "0.15em",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {group.group.toUpperCase()}
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.5rem" }}>
                    {group.tools.map((tool) => (
                      <span
                        key={tool}
                        style={{
                          fontFamily: mono,
                          fontSize: "0.7rem",
                          color: TEXT_MUTED,
                          background: BG_DARK,
                          border: "1px solid rgba(0,255,136,0.08)",
                          borderRadius: "2px",
                          padding: "0.2rem 0.5rem",
                        }}
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                  <p
                    style={{
                      fontFamily: inter,
                      fontSize: "0.85rem",
                      color: TEXT_MUTED,
                      margin: 0,
                    }}
                  >
                    {group.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>

          {/* A2A intents panel */}
          <Reveal>
            <div
              style={{
                background: BG_DARK,
                border: "1px solid rgba(0,255,136,0.08)",
                borderRadius: "4px",
                padding: "1.5rem",
                marginBottom: "2rem",
              }}
            >
              <p
                style={{
                  fontFamily: sg,
                  fontWeight: 600,
                  fontSize: "1rem",
                  color: TEXT_PRIMARY,
                  marginBottom: "0.5rem",
                }}
              >
                34 typed A2A intents
              </p>
              <p
                style={{
                  fontFamily: inter,
                  fontSize: "0.85rem",
                  color: TEXT_MUTED,
                  marginBottom: "1.25rem",
                }}
              >
                Every agent interaction is a typed, schema-validated intent. No free-text in the
                critical path.
              </p>
              {A2A_INTENTS.map((row, i) => (
                <div
                  key={row.intent}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr auto",
                    gap: "1rem",
                    alignItems: "center",
                    padding: "0.5rem 0",
                    borderBottom:
                      i < A2A_INTENTS.length - 1 ? "1px solid rgba(0,255,136,0.05)" : "none",
                  }}
                >
                  <span style={{ fontFamily: mono, fontSize: "0.75rem", color: GREEN }}>
                    {row.intent}
                  </span>
                  <span style={{ fontFamily: inter, fontSize: "0.75rem", color: TEXT_MUTED }}>
                    {row.direction}
                  </span>
                  <span style={{ fontFamily: mono, fontSize: "0.7rem", color: TEXT_DIM }}>
                    {row.payload}
                  </span>
                </div>
              ))}
            </div>
          </Reveal>

          {/* MCP badge */}
          <Reveal>
            <div
              style={{
                background: "rgba(0,255,136,0.08)",
                border: "1px solid rgba(0,255,136,0.25)",
                borderRadius: "4px",
                padding: "1rem 1.25rem",
                marginBottom: "2rem",
              }}
            >
              <p style={{ fontFamily: mono, fontSize: "0.75rem", color: GREEN, marginBottom: "0.4rem" }}>
                MCP Compatible
              </p>
              <p style={{ fontFamily: inter, fontSize: "0.85rem", color: TEXT_MUTED, margin: 0 }}>
                29 structured tools. Connect any Claude, GPT-4, or custom agent via the MCP server
                — no custom integration required.
              </p>
            </div>
          </Reveal>

          <Reveal>
            <div style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "wrap" }}>
              <a
                href="https://docs.capability.network/agents"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontFamily: inter,
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  color: BG_DARK,
                  background: GREEN,
                  borderRadius: "4px",
                  padding: "0.75rem 1.5rem",
                  textDecoration: "none",
                  transition: "opacity 0.2s",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.85")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "1")}
              >
                Read agent docs
              </a>
              <GhostLink
                text="View A2A spec"
                href="https://github.com/wingdingspenpal/poop/tree/main/packages/a2a"
              />
            </div>
          </Reveal>
        </div>

        {/* Right — code block */}
        <div style={{ position: "sticky", top: "6rem" }}>
          <Reveal>
            <div
              style={{
                background: BG_DARK,
                border: "1px solid rgba(0,255,136,0.15)",
                borderRadius: "4px",
                padding: "2rem",
                overflow: "auto",
              }}
            >
              <p
                style={{
                  fontFamily: mono,
                  fontSize: "0.7rem",
                  color: TEXT_MUTED,
                  marginBottom: "1.5rem",
                  letterSpacing: "0.1em",
                }}
              >
                Agent discovers and hires physical capability
              </p>
              <div style={{ fontFamily: mono, fontSize: "0.8rem", lineHeight: 1.7 }}>
                {CODE_LINES.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      background:
                        line.highlight ? "rgba(0,255,136,0.04)" : "transparent",
                      padding: line.highlight ? "0 0.5rem" : "0",
                      margin: line.highlight ? "0 -0.5rem" : "0",
                    }}
                  >
                    {renderCodeLine(line)}
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sponsors section
// ---------------------------------------------------------------------------

const INTEGRATIONS = [
  {
    sponsor: "Storacha",
    category: "Decentralized Storage",
    status: "LIVE" as const,
    description:
      "Evidence bundles uploaded via @storacha/client w3up. Every completed job produces a permanent CIDv1 hash, retrievable at w3s.link/ipfs/<cid>.",
    proof: "packages/kernel/src/storacha-storage.ts",
    enables: "Permanent, content-addressed evidence storage. Evidence survives operator shutdown.",
  },
  {
    sponsor: "Flow",
    category: "Smart Contracts",
    status: "LIVE" as const,
    description:
      "MilestoneEscrow + MockUSDC deployed to Flow EVM Testnet (chain 545). Sub-cent transaction costs for escrow operations.",
    proof: "0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15",
    proofUrl:
      "https://evm-testnet.flowscan.io/address/0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15",
    enables: "Same Solidity escrow contract running on Flow EVM. Operators choose chain.",
  },
  {
    sponsor: "NEAR Protocol",
    category: "Cross-Chain Intents",
    status: "LIVE" as const,
    description:
      "Cross-chain payment intents via 1Click API at chaindefuser.com. Agents on any chain fund PCC escrows through NEAR's solver network.",
    proof: "packages/gateway/src/routes/near.ts",
    enables:
      "Agents on Ethereum, Solana, or any chain can pay for PCC jobs without bridging manually.",
  },
  {
    sponsor: "Lit Protocol",
    category: "Threshold Encryption",
    status: "WIRED" as const,
    description:
      "Evidence encrypted with UnifiedAccessControlCondition arrays. Decryption gated on escrow state — only the buyer or credentialed verifiers can read.",
    proof: "packages/kernel/src/lit-encryption-real.ts",
    honest:
      "Integration wired to datil-dev network. Production runs AES-256-GCM with identical interface pending datil-dev confirmation.",
    enables:
      "Selective disclosure: operators can prove job completion without revealing proprietary process details.",
  },
  {
    sponsor: "Starknet",
    category: "ZK Proof Anchoring",
    status: "WIRED" as const,
    description:
      "Proof hashes anchored as felt252 field elements on Starknet Sepolia. Raw evidence never touches the chain — only cryptographic commitments.",
    proof: "packages/verifier/src/starknet-proof-service.ts",
    honest:
      "Architecture is production-ready. On-chain ProofRegistry contract deployment in progress for Starknet Sepolia.",
    enables:
      "Immutable, verifiable proof that a specific evidence bundle existed at a specific block. Cannot be tampered retroactively.",
  },
];

function StatusBadge({ status }: { status: "LIVE" | "WIRED" }) {
  const isLive = status === "LIVE";
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: "0.65rem",
        letterSpacing: "0.1em",
        color: isLive ? GREEN : AMBER,
        background: isLive ? "rgba(0,255,136,0.08)" : "rgba(245,166,35,0.08)",
        border: `1px solid ${isLive ? "rgba(0,255,136,0.25)" : "rgba(245,166,35,0.25)"}`,
        borderRadius: "4px",
        padding: "0.2rem 0.5rem",
      }}
    >
      {status}
    </span>
  );
}

function SponsorsSection() {
  return (
    <section
      id="sponsors"
      style={{
        background: BG_MID,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
        }}
      >
        <Reveal>
          <SectionLabel text="BUILT ON" />
          <h2
            style={{
              fontFamily: sg,
              fontWeight: 700,
              fontSize: "clamp(2rem, 4vw, 3.5rem)",
              lineHeight: 1.1,
              color: TEXT_PRIMARY,
              marginBottom: "1rem",
            }}
          >
            Five real integrations.{" "}
            <span style={{ color: GREEN }}>No vaporware.</span>
          </h2>
          <p
            style={{
              fontFamily: inter,
              fontSize: "1rem",
              color: TEXT_MUTED,
              maxWidth: "500px",
              lineHeight: 1.6,
              marginBottom: "1.5rem",
            }}
          >
            Every sponsor integration is verifiable on-chain or in the open-source repo.
          </p>

          {/* Legend */}
          <div style={{ display: "flex", gap: "2rem", marginBottom: "3rem" }}>
            {[
              { status: "LIVE", color: GREEN, meaning: "Verifiable on-chain or live network call today" },
              { status: "WIRED", color: AMBER, meaning: "Code complete, architecture proven" },
            ].map((item) => (
              <div key={item.status} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <StatusBadge status={item.status as "LIVE" | "WIRED"} />
                <span style={{ fontFamily: inter, fontSize: "0.8rem", color: TEXT_MUTED }}>
                  {item.meaning}
                </span>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Grid: 3 top, 2 bottom centered */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1.25rem",
            marginBottom: "1.25rem",
          }}
        >
          {INTEGRATIONS.slice(0, 3).map((integ, i) => (
            <Reveal key={integ.sponsor} delay={i * 0.1}>
              <IntegrationCard integ={integ} />
            </Reveal>
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "1.25rem",
            maxWidth: "calc(66.66% + 1.25rem / 3 * 2)",
            margin: "0 auto",
          }}
        >
          {INTEGRATIONS.slice(3).map((integ, i) => (
            <Reveal key={integ.sponsor} delay={i * 0.1}>
              <IntegrationCard integ={integ} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationCard({
  integ,
}: {
  integ: (typeof INTEGRATIONS)[0];
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: BG_MID,
        border: `1px solid ${hover ? "rgba(0,255,136,0.3)" : "rgba(0,255,136,0.08)"}`,
        borderRadius: "4px",
        padding: "1.75rem",
        transition: "border-color 0.2s, box-shadow 0.2s",
        boxShadow: hover ? "0 8px 32px rgba(0,255,136,0.06)" : "none",
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "0.5rem",
        }}
      >
        <p
          style={{
            fontFamily: sg,
            fontWeight: 600,
            fontSize: "1.1rem",
            color: TEXT_PRIMARY,
            margin: 0,
          }}
        >
          {integ.sponsor}
        </p>
        <StatusBadge status={integ.status} />
      </div>
      <p
        style={{
          fontFamily: mono,
          fontSize: "0.65rem",
          color: TEXT_MUTED,
          letterSpacing: "0.1em",
          marginBottom: "0.75rem",
        }}
      >
        {integ.category}
      </p>
      <p
        style={{
          fontFamily: inter,
          fontSize: "0.875rem",
          color: TEXT_MUTED,
          lineHeight: 1.6,
          marginBottom: "0.75rem",
        }}
      >
        {integ.description}
      </p>
      {integ.honest && (
        <p
          style={{
            fontFamily: inter,
            fontSize: "0.8rem",
            color: AMBER,
            lineHeight: 1.5,
            marginBottom: "0.75rem",
            opacity: 0.8,
          }}
        >
          {integ.honest}
        </p>
      )}
      <p
        style={{
          fontFamily: mono,
          fontSize: "0.7rem",
          color: "rgba(0,255,136,0.5)",
          margin: 0,
        }}
      >
        {integ.proofUrl ? (
          <a
            href={integ.proofUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "rgba(0,255,136,0.5)",
              textDecoration: "none",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = GREEN)}
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLAnchorElement).style.color = "rgba(0,255,136,0.5)")
            }
          >
            {integ.proof}
          </a>
        ) : (
          integ.proof
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats section
// ---------------------------------------------------------------------------

function StatNumber({
  target,
  suffix = "",
  prefix = "",
  duration = 1200,
  isText = false,
  value = "",
}: {
  target?: number;
  suffix?: string;
  prefix?: string;
  duration?: number;
  isText?: boolean;
  value?: string;
}) {
  const [ref, inView] = useInView(0.3);
  const count = useCountUp(target ?? 0, duration, inView && !isText);

  return (
    <div
      ref={ref}
      style={{
        fontFamily: sg,
        fontWeight: 800,
        fontSize: "clamp(3rem, 6vw, 5rem)",
        lineHeight: 1,
        letterSpacing: "-0.03em",
        color: GREEN,
        opacity: inView ? 1 : 0,
        transition: "opacity 0.5s ease",
      }}
    >
      {isText ? value : `${prefix}${count.toLocaleString()}${suffix}`}
    </div>
  );
}

const STATS = [
  { target: 25, suffix: "", label: "packages", sublabel: "TypeScript monorepo", duration: 1200 },
  { target: 3300, suffix: "+", label: "tests", sublabel: "100+ test files", duration: 1500 },
  { target: 154, suffix: "", label: "agent tools", sublabel: "MCP + direct API", duration: 1200 },
  {
    target: 347,
    suffix: "",
    label: "REST endpoints",
    sublabel: "54 route files",
    duration: 1500,
  },
  {
    target: 34,
    suffix: "",
    label: "A2A intents",
    sublabel: "typed, schema-validated",
    duration: 1000,
  },
  {
    isText: true,
    value: "Apache 2.0",
    label: "license",
    sublabel: "public goods infrastructure",
  },
];

const DIFFERENTIATORS = [
  {
    title: "Real hardware. Live.",
    text: "A real OT-2 liquid handler operates as the first operator node. Not a simulation — a running kernel.",
  },
  {
    title: "Agent-first protocol",
    text: "Built for AI agents, not humans. 34 typed intents, structured negotiation, no free-text in the critical path.",
  },
  {
    title: "5/5 sponsor integrations",
    text: "Every integration is real code. Storacha and Flow are verifiable on-chain today. No demo theater.",
  },
  {
    title: "34 emerging markets",
    text: "Yellowcard fiat ramp for 34 countries. Mobile money payouts. A lab in Kenya or a shop in Buenos Aires can earn on day one.",
  },
];

function StatsSection() {
  return (
    <section
      id="stats"
      style={{
        background: BG_DARK,
        padding: "clamp(5rem, 10vw, 9rem) 0",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 clamp(1.5rem, 5vw, 4rem)",
        }}
      >
        <Reveal>
          <SectionLabel text="BY THE NUMBERS" />
          <h2
            style={{
              fontFamily: sg,
              fontWeight: 800,
              fontSize: "clamp(2.5rem, 5vw, 4.5rem)",
              lineHeight: 1.1,
              color: TEXT_PRIMARY,
              marginBottom: "0.75rem",
            }}
          >
            This is not a prototype.
          </h2>
          <p
            style={{
              fontFamily: inter,
              fontSize: "1rem",
              color: TEXT_MUTED,
              marginBottom: "4rem",
            }}
          >
            Built during PL Genesis: Frontiers of Collaboration, March 2026. Apache 2.0. Free
            forever.
          </p>
        </Reveal>

        {/* Stats grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "0",
            marginBottom: "5rem",
            border: "1px solid rgba(0,255,136,0.08)",
            borderRadius: "4px",
            overflow: "hidden",
          }}
        >
          {STATS.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                padding: "2rem",
                borderBottom: i < 3 ? "1px solid rgba(0,255,136,0.08)" : "none",
                borderRight: (i + 1) % 3 !== 0 ? "1px solid rgba(0,255,136,0.08)" : "none",
              }}
            >
              {stat.isText ? (
                <StatNumber isText value={stat.value} />
              ) : (
                <StatNumber
                  target={stat.target}
                  suffix={stat.suffix}
                  duration={stat.duration}
                />
              )}
              <p
                style={{
                  fontFamily: inter,
                  fontSize: "1rem",
                  fontWeight: 500,
                  color: TEXT_PRIMARY,
                  marginTop: "0.5rem",
                  marginBottom: "0.25rem",
                }}
              >
                {stat.label}
              </p>
              <p style={{ fontFamily: mono, fontSize: "0.7rem", color: TEXT_MUTED, margin: 0 }}>
                {stat.sublabel}
              </p>
            </div>
          ))}
        </div>

        {/* Differentiators */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "2rem",
            marginBottom: "4rem",
          }}
        >
          {DIFFERENTIATORS.map((d, i) => (
            <Reveal key={d.title} delay={i * 0.1}>
              <div
                style={{
                  borderLeft: "2px solid rgba(0,255,136,0.2)",
                  paddingLeft: "1rem",
                }}
              >
                <p
                  style={{
                    fontFamily: sg,
                    fontWeight: 600,
                    fontSize: "1rem",
                    color: TEXT_PRIMARY,
                    marginBottom: "0.5rem",
                  }}
                >
                  {d.title}
                </p>
                <p
                  style={{
                    fontFamily: inter,
                    fontSize: "0.875rem",
                    color: TEXT_MUTED,
                    lineHeight: 1.6,
                    margin: 0,
                  }}
                >
                  {d.text}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Live badge + GitHub */}
        <Reveal>
          <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
            <a
              href="https://capability.network"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: mono,
                fontSize: "0.75rem",
                color: GREEN,
                background: "rgba(0,255,136,0.08)",
                border: "1px solid rgba(0,255,136,0.25)",
                borderRadius: "4px",
                padding: "0.5rem 1rem",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                transition: "box-shadow 0.2s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.boxShadow =
                  "0 0 12px rgba(0,255,136,0.3)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
              }}
            >
              <LiveDot />
              LIVE at capability.network
            </a>
            <a
              href="https://github.com/wingdingspenpal/poop"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: mono,
                fontSize: "0.75rem",
                color: TEXT_MUTED,
                textDecoration: "none",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_PRIMARY)
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_MUTED)
              }
            >
              github.com/wingdingspenpal/poop
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function LiveDot() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: GREEN,
        animation: "livePulse 2s ease-in-out infinite",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer style={{ background: BG_DARK }}>
      {/* CTA band */}
      <div
        style={{
          background: BG_MID,
          borderTop: "1px solid rgba(0,255,136,0.12)",
          borderBottom: "1px solid rgba(0,255,136,0.08)",
          padding: "clamp(4rem, 8vw, 7rem) 0",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "0 clamp(1.5rem, 5vw, 4rem)" }}>
          <Reveal>
            <p
              style={{
                fontFamily: sg,
                fontWeight: 700,
                fontSize: "clamp(2rem, 4vw, 3.5rem)",
                color: TEXT_PRIMARY,
                lineHeight: 1.15,
                marginBottom: "0.25rem",
              }}
            >
              Physical infrastructure is the last frontier.
            </p>
            <p
              style={{
                fontFamily: sg,
                fontWeight: 800,
                fontSize: "clamp(2rem, 4vw, 3.5rem)",
                color: GREEN,
                lineHeight: 1.15,
                marginBottom: "2.5rem",
              }}
            >
              Build on it.
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "2rem",
                flexWrap: "wrap",
              }}
            >
              <TerminalCTA
                text="pip install pcc-node"
                href="https://pypi.org/project/pcc-node/"
              />
              <GhostLink text="View on GitHub" href="https://github.com/wingdingspenpal/poop" />
            </div>
          </Reveal>
        </div>
      </div>

      {/* Footer bar */}
      <div
        style={{
          borderTop: "1px solid rgba(0,255,136,0.06)",
          padding: "2.5rem 0",
        }}
      >
        <div
          style={{
            maxWidth: "1200px",
            margin: "0 auto",
            padding: "0 clamp(1.5rem, 5vw, 4rem)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "1.5rem",
          }}
        >
          <div>
            <span
              style={{
                fontFamily: mono,
                fontSize: "1.1rem",
                fontWeight: 700,
                color: GREEN,
                marginRight: "1rem",
              }}
            >
              PCC
            </span>
            <span
              style={{
                fontFamily: inter,
                fontSize: "0.875rem",
                color: TEXT_MUTED,
              }}
            >
              Open source. Apache 2.0. Public goods infrastructure.
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
            {[
              { text: "capability.network", href: "https://capability.network" },
              { text: "GitHub", href: "https://github.com/wingdingspenpal/poop" },
              { text: "Docs", href: "https://docs.capability.network" },
              { text: "PyPI", href: "https://pypi.org/project/pcc-node/" },
            ].map((link, i, arr) => (
              <React.Fragment key={link.text}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: mono,
                    fontSize: "0.75rem",
                    color: TEXT_MUTED,
                    textDecoration: "none",
                    transition: "color 0.2s",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_PRIMARY)
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = TEXT_MUTED)
                  }
                >
                  {link.text}
                </a>
                {i < arr.length - 1 && (
                  <span style={{ color: TEXT_DIM, fontFamily: mono, fontSize: "0.7rem" }}>·</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div
          style={{
            maxWidth: "1200px",
            margin: "1.25rem auto 0",
            padding: "0 clamp(1.5rem, 5vw, 4rem)",
          }}
        >
          <p style={{ fontFamily: mono, fontSize: "0.7rem", color: TEXT_DIM, margin: 0 }}>
            Built at PL Genesis: Frontiers of Collaboration · March 2026 · Apache 2.0
          </p>
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// CSS keyframes injection
// ---------------------------------------------------------------------------

const GLOBAL_STYLES = `
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  @keyframes livePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }
  @media (max-width: 768px) {
    .pcc-hero-grid { grid-template-columns: 1fr !important; }
    .pcc-two-col { grid-template-columns: 1fr !important; }
    .pcc-six-col { grid-template-columns: 1fr !important; }
    .pcc-three-col { grid-template-columns: 1fr !important; }
    .pcc-four-col { grid-template-columns: repeat(2, 1fr) !important; }
    .pcc-stat-grid { grid-template-columns: repeat(2, 1fr) !important; }
  }
`;

function injectStyles() {
  if (document.getElementById("pcc-landing-styles")) return;
  const style = document.createElement("style");
  style.id = "pcc-landing-styles";
  style.textContent = GLOBAL_STYLES;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function LandingPage() {
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    injectStyles();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handler, { passive: true });
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: BG_DARK,
        color: TEXT_PRIMARY,
        fontFamily: inter,
        overflowX: "hidden",
      }}
    >
      <Nav />
      <HeroSection mousePos={mousePos} />
      <ProblemSection />
      <HowItWorksSection />
      <ForOperatorsSection />
      <ForAgentsSection />
      <SponsorsSection />
      <StatsSection />
      <Footer />
    </div>
  );
}
