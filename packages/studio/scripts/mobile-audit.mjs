#!/usr/bin/env node
/**
 * Mobile layout audit for InkOS Studio.
 *
 * Opens the key reading/editing pages at phone and desktop viewports, saves a
 * screenshot per page per viewport and reports, per page:
 *   - docOverflow: document.scrollWidth - innerWidth (must be <= 0)
 *   - clipped:     visible elements that stick out past the viewport edge and
 *                  are not inside a horizontal scroll container (content the
 *                  app shell's overflow:hidden would silently cut off)
 *   - smallTargets: visible buttons/links/inputs smaller than 44px on a side
 *   - tinyText:    visible text rendered below 12px
 *
 * Usage (against a running Studio):
 *   node scripts/mobile-audit.mjs --base http://localhost:4567 --book <bookId> \
 *     --out ./mobile-audit --prefix after [--chrome /usr/bin/google-chrome]
 *
 * Writes <out>/<prefix>-<page>-<w>x<h>.png and <out>/<prefix>-report.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]?.startsWith("--") ? "1" : (all[index + 1] ?? "1")]);
    return pairs;
  }, []),
);
const base = (args.base ?? "http://localhost:4567").replace(/\/$/, "");
const bookId = args.book;
const out = args.out ?? "mobile-audit";
const prefix = args.prefix ?? "audit";
if (!bookId) {
  console.error("--book <bookId> is required");
  process.exit(2);
}

const VIEWPORTS = (args.viewports ?? "360x740,390x844,430x932,1280x800")
  .split(",")
  .map((spec) => {
    const [width, height] = spec.split("x").map(Number);
    return { width, height, mobile: width < 768 };
  });

const bookHash = `#/book/${encodeURIComponent(bookId)}`;

async function settle(page, ms = 700) {
  await page.waitForTimeout(ms);
}

let loads = 0;
async function gotoHash(page, hash) {
  // Always a fresh document load: some routes are in-memory only, so the URL
  // may already equal the target and a plain goto would be a no-op.
  loads += 1;
  await page.goto(`${base}/?audit=${loads}${hash}`, { waitUntil: "domcontentloaded" });
}

/** Tap like a user; if the control is unreachable (clipped off-screen), note it and click programmatically. */
async function tap(page, locator, entry, label) {
  try {
    await locator.click({ timeout: 3000 });
  } catch {
    (entry.unreachable ??= []).push(label);
    await locator.evaluate((el) => el.click());
  }
}

async function openChapterFromSettings(page, entry) {
  await gotoHash(page, `${bookHash}/settings`);
  const link = page.locator("[data-testid=chapter-open]:visible, table tbody button:visible").first();
  await link.waitFor({ timeout: 15000 });
  await tap(page, link, entry, "chapter-link");
  await page.locator(".paper-sheet article, [data-testid=chapter-body]").first().waitFor({ timeout: 15000 });
}

const PAGES = [
  {
    name: "books",
    async open(page) {
      await gotoHash(page, "#/");
      await page.locator("h1").first().waitFor({ timeout: 15000 });
    },
  },
  {
    name: "book",
    async open(page) {
      await gotoHash(page, bookHash);
      await settle(page, 1500);
    },
  },
  {
    name: "status",
    async open(page) {
      await gotoHash(page, `${bookHash}/settings`);
      await page.locator("table:visible, [data-testid=chapter-cards]:visible").first().waitFor({ timeout: 15000 });
    },
  },
  {
    name: "reader",
    open: openChapterFromSettings,
  },
  {
    name: "editor",
    async open(page, entry) {
      await openChapterFromSettings(page, entry);
      await tap(page, page.getByRole("button", { name: /^\s*(编辑|Edit)\s*$/ }).first(), entry, "edit-button");
      await page.locator("textarea[data-testid=chapter-editor], .paper-sheet textarea").first().waitFor({ timeout: 10000 });
    },
  },
  {
    name: "daemon",
    async open(page, entry) {
      await gotoHash(page, "#/daemon");
      await settle(page, 500);
      const heading = page.getByRole("heading", { name: /守护进程|Daemon/ });
      if (!(await heading.count())) {
        // Phone layout: the sidebar lives in a drawer behind the header button.
        const toggle = page.locator("[data-testid=nav-drawer-toggle]:visible");
        if (await toggle.count()) {
          await toggle.click();
          await settle(page, 400);
        }
        await tap(page, page.getByRole("button", { name: /守护进程|Daemon/ }).first(), entry, "daemon-nav");
      }
      await settle(page);
    },
  },
];

async function measure(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 24);
      return `${el.tagName.toLowerCase()}${label ? `「${label}」` : ""} ${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)}`;
    };
    // An element is in a horizontal scroller (fine) if some ancestor scrolls on x.
    const inScroller = (el) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const ox = getComputedStyle(node).overflowX;
        if ((ox === "auto" || ox === "scroll") && node.scrollWidth > node.clientWidth + 1) return true;
      }
      return false;
    };
    // Off-canvas drawers that are closed sit translated off-screen on purpose.
    const inClosedDrawer = (el) => {
      const drawer = el.closest("[data-drawer-state=closed]");
      return Boolean(drawer && drawer.getBoundingClientRect().right <= 1);
    };

    const clipped = [];
    const all = Array.from(document.body.querySelectorAll("*"));
    for (const el of all) {
      if (el.children.length > 0 && !["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "TABLE", "IMG", "SVG"].includes(el.tagName)) {
        // only test leaves and controls: containers are covered by their content
        const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasOwnText) continue;
      }
      if (!visible(el) || inClosedDrawer(el)) continue;
      const rect = el.getBoundingClientRect();
      if ((rect.right > vw + 1 || rect.left < -1) && !inScroller(el)) clipped.push(describe(el));
    }

    const controls = Array.from(document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button]"))
      .filter((el) => visible(el) && !inClosedDrawer(el));
    const small = controls.filter((el) => {
      const label = el.matches("input[type=checkbox], input[type=radio]") ? el.closest("label") : null;
      const rect = (label ?? el).getBoundingClientRect();
      return rect.height < 44 || rect.width < 44;
    });

    let tinyText = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const tinySamples = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || !visible(el) || inClosedDrawer(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) {
        tinyText += 1;
        if (tinySamples.length < 5) tinySamples.push(`${size}px「${node.textContent.trim().slice(0, 12)}」`);
      }
    }

    // The app shell clips overflow (overflow:hidden), which hides horizontal
    // overflow from document.scrollWidth; measure the shell and scroller too.
    const shells = [document.body, document.getElementById("root")?.firstElementChild, document.querySelector("main")].filter(Boolean);
    const shellOverflow = Math.max(0, ...shells.map((el) => el.scrollWidth - el.clientWidth));
    const bodyText = document.querySelector(".paper-sheet article p, [data-testid=chapter-body] p");
    return {
      innerWidth: vw,
      scrollWidth: document.documentElement.scrollWidth,
      docOverflow: document.documentElement.scrollWidth - vw,
      shellOverflow,
      clippedCount: clipped.length,
      clipped: clipped.slice(0, 8),
      controls: controls.length,
      smallTargets: small.length,
      smallSamples: small.slice(0, 8).map(describe),
      tinyText,
      tinySamples,
      readerFontPx: bodyText ? parseFloat(getComputedStyle(bodyText).fontSize) : null,
    };
  });
}

/** Simulate an on-screen keyboard: shrink the viewport while the editor has focus. */
async function keyboardCheck(page, viewport) {
  const keyboardHeight = Math.round(viewport.height * 0.42);
  await page.setViewportSize({ width: viewport.width, height: viewport.height - keyboardHeight });
  const editor = page.locator("textarea[data-testid=chapter-editor], .paper-sheet textarea").first();
  await editor.focus();
  await editor.evaluate((el) => {
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollIntoView({ block: "center" });
  });
  await settle(page, 400);
  const result = await page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const inView = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.height > 0;
    };
    const editor = document.querySelector("textarea[data-testid=chapter-editor], .paper-sheet textarea");
    const save = Array.from(document.querySelectorAll("button")).find((b) => /^(保存|Save|保存中|Saving)/.test((b.textContent || "").trim()));
    const r = editor?.getBoundingClientRect();
    return {
      viewportHeight: vh,
      editorFocused: document.activeElement === editor,
      editorVisible: inView(editor),
      editorVisibleHeight: r ? Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top)) : 0,
      saveVisible: inView(save),
      docOverflow: document.documentElement.scrollWidth - vw,
    };
  });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  return result;
}

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: args.chrome ?? process.env.CHROME_PATH ?? undefined,
    args: ["--disable-gpu", "--no-sandbox"],
  });
  const report = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.mobile ? 2 : 1,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        locale: "zh-CN",
      });
      const page = await context.newPage();
      for (const target of PAGES) {
        const tag = `${target.name}-${viewport.width}x${viewport.height}`;
        const entry = { page: target.name, viewport: `${viewport.width}x${viewport.height}` };
        try {
          await target.open(page, entry);
          await settle(page);
          Object.assign(entry, await measure(page));
          await page.screenshot({ path: join(out, `${prefix}-${tag}.png`) });
          const below = { status: "[data-testid=chapter-cards]:visible, table:visible", reader: "[data-testid=chapter-next], [data-testid=chapter-prev]" }[target.name];
          if (below) {
            const anchor = page.locator(below).first();
            if (await anchor.count()) {
              await anchor.evaluate((el) => el.scrollIntoView({ block: "center" }));
              await settle(page, 400);
              entry.scrolled = await measure(page);
              await page.screenshot({ path: join(out, `${prefix}-${target.name}-scrolled-${viewport.width}x${viewport.height}.png`) });
            }
          }
          if (target.name === "editor" && viewport.mobile) {
            entry.keyboard = await keyboardCheck(page, viewport);
            await page.setViewportSize({ width: viewport.width, height: viewport.height - Math.round(viewport.height * 0.42) });
            await page.screenshot({ path: join(out, `${prefix}-editor-keyboard-${viewport.width}x${viewport.height}.png`) });
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
          }
          if (target.name === "books" && viewport.mobile) {
            const toggle = page.locator("[data-testid=nav-drawer-toggle]");
            if (await toggle.count()) {
              await toggle.click();
              await settle(page, 400);
              entry.drawer = await measure(page);
              await page.screenshot({ path: join(out, `${prefix}-nav-drawer-${viewport.width}x${viewport.height}.png`) });
              await page.keyboard.press("Escape");
              await settle(page, 300);
            }
          }
        } catch (error) {
          entry.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
          await page.screenshot({ path: join(out, `${prefix}-${tag}.png`) }).catch(() => undefined);
        }
        report.push(entry);
        const flag = entry.error ? `ERROR ${entry.error}` : `overflow=${entry.docOverflow} shell=${entry.shellOverflow} clipped=${entry.clippedCount} small=${entry.smallTargets}/${entry.controls} tiny=${entry.tinyText}${entry.unreachable ? ` unreachable=${entry.unreachable.join("+")}` : ""}${entry.keyboard ? ` kb(editor=${entry.keyboard.editorVisible},save=${entry.keyboard.saveVisible})` : ""}`;
        console.log(`${prefix} ${tag.padEnd(22)} ${flag}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(out, `${prefix}-report.json`), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
