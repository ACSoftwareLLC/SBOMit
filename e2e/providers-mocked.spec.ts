import { test, expect } from "@playwright/test";
import { registerAndLogin } from "./helpers/auth";

const fakeProviders = {
  providers: [
    {
      id: "cfg-openai",
      name: "OpenAI Test",
      provider: "openai",
      models: ["gpt-test-mini", "gpt-test-large"],
      isDefault: true,
    },
    {
      id: "cfg-anthropic",
      name: "Anthropic Test",
      provider: "anthropic",
      models: ["claude-test-sonnet"],
      isDefault: false,
    },
  ],
};

test.describe("audit form provider selection (mocked /api/providers)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/providers", (route) =>
      route.fulfill({ json: fakeProviders }),
    );
    await registerAndLogin(page);
  });

  test("provider select populates from API", async ({ page }) => {
    const provider = page.getByLabel("AI provider");
    await expect(provider).toHaveValue("cfg-openai");
    await expect(provider.getByRole("option", { name: /openai test/i })).toHaveCount(1);
    await expect(
      provider.getByRole("option", { name: /anthropic test/i }),
    ).toHaveCount(1);
  });

  test("model select follows selected provider", async ({ page }) => {
    const model = page.getByLabel("Model");
    await expect(model).toHaveValue("gpt-test-mini");

    await page.getByLabel("AI provider").selectOption("cfg-anthropic");
    await expect(model).toHaveValue("claude-test-sonnet");
  });

  test("Audit Library enabled with provider and model selected", async ({ page }) => {
    await page
      .getByPlaceholder("npm package or GitHub URL, e.g. lodash")
      .fill("lodash");
    const submit = page.getByRole("button", { name: /audit library/i });
    await expect(submit).toBeEnabled();
  });
});
