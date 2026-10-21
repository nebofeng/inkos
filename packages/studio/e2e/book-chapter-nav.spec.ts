import { test, expect } from "@playwright/test";
import { seedBookChapterNav, E2E_NAV_BOOK_ID } from "./fixtures/seed-book-chapter-nav";

test.beforeAll(async () => {
  await seedBookChapterNav();
});

test("book page chapter list navigates to the chapter reader and back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Studio refuses access without auth config; when the runner sets local throwaway
  // credentials (E2E_STUDIO_USER / E2E_STUDIO_PASS), log in through the API first.
  if (process.env.E2E_STUDIO_USER && process.env.E2E_STUDIO_PASS) {
    const login = await page.request.post("/api/v1/auth/login", {
      data: { username: process.env.E2E_STUDIO_USER, password: process.env.E2E_STUDIO_PASS },
    });
    expect(login.ok()).toBeTruthy();
  }
  const bookHash = `#/book/${encodeURIComponent(E2E_NAV_BOOK_ID)}`;
  await page.goto(`/${bookHash}`);

  const first = page.getByTestId("book-chapter-link").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(first).toHaveAttribute("href", `${bookHash}/chapter/1`);
  await page.screenshot({ path: process.env.RD051_SHOTS ? `${process.env.RD051_SHOTS}/01-book.png` : "test-results/rd051-01-book.png" });
  await first.click();

  await expect(page).toHaveURL(/#\/book\/[^/]+\/chapter\/1$/);
  // RD-047 annotation entry lives in the chapter reader's right rail.
  await expect(page.getByTestId("rail-tab-header")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chapter-body")).toContainText("账本", { timeout: 15_000 });
  await page.screenshot({ path: process.env.RD051_SHOTS ? `${process.env.RD051_SHOTS}/02-chapter.png` : "test-results/rd051-02-chapter.png" });

  await page.getByTestId("header-crumb").click();
  await expect(page).toHaveURL(new RegExp(`${bookHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByTestId("book-chapter-link").first()).toBeVisible({ timeout: 15_000 });

  // Browser back also returns to the reader, then forward/back keep working.
  await page.goBack();
  await expect(page).toHaveURL(/\/chapter\/1$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(E2E_NAV_BOOK_ID)}$`));
  await page.screenshot({ path: process.env.RD051_SHOTS ? `${process.env.RD051_SHOTS}/03-back-to-book.png` : "test-results/rd051-03-back-to-book.png" });
});
