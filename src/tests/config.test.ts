import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import type { Config } from "../lib/types.ts";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

const CANCEL = Symbol.for("clack/cancel");

const BASE_CONFIG: Config = {
  baseUrl: "https://test.atlassian.net",
  accountId: "acc1",
  authType: "cloud",
  jiraPat: "$JIRA_PAT",
  tempoPat: "$TEMPO_PAT",
  email: "test@example.com",
};

const mockSaveConfig = mock((_: Config) => {});
const mockLoadConfig = mock(() => ({ ...BASE_CONFIG }));
const mockConfigExists = mock(() => true);

mock.module("../lib/config.ts", () => ({
  saveConfig: mockSaveConfig,
  loadConfig: mockLoadConfig,
  configExists: mockConfigExists,
  resolvePat: (v: string) => v,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockText   = mock(async (_args: any): Promise<any> => "");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSelect = mock(async (_args: any): Promise<any> => "cloud");

const mockLogError   = mock((_: string) => {});
const mockLogSuccess = mock((_: string) => {});

mock.module("@clack/prompts", () => ({
  text:     mockText,
  select:   mockSelect,
  isCancel: (v: unknown) => v === CANCEL,
  log:      { error: mockLogError, success: mockLogSuccess },
  cancel:   mock(() => {}),
  intro:    mock(() => {}),
  outro:    mock(() => {}),
  spinner:  () => ({ start: mock(() => {}), stop: mock(() => {}), message: mock(() => {}) }),
}));

mock.module("../lib/jira.ts", () => ({
  getMyself: async () => ({ accountId: "acc-new", displayName: "Test User", emailAddress: "test@example.com" }),
}));

mock.module("picocolors", () => ({
  default: {
    bgCyan: (s: string) => s,
    black:  (s: string) => s,
    green:  (s: string) => s,
    bold:   (s: string) => s,
    dim:    (s: string) => s,
  },
}));

// Prevent process.exit from terminating the test runner
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).exit = mock((_?: number) => {});

import { getConfig, setConfig, runConfig } from "../cli/config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture options passed to the next p.select call, then resolve with returnValue. */
function captureSelectAndReturn(returnValue: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Promise<any[]>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSelect.mockImplementationOnce(async ({ options }: { options: any[] }) => {
      resolve(options);
      return returnValue;
    });
  });
}

beforeEach(() => {
  mockSaveConfig.mockClear();
  mockLoadConfig.mockClear();
  mockText.mockClear();
  mockSelect.mockClear();
  mockLogError.mockClear();
  mockLogSuccess.mockClear();
  mockLoadConfig.mockImplementation(() => ({ ...BASE_CONFIG }));
});

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

describe("getConfig — single key", () => {
  test("prints the current value for a flat key", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    await getConfig("baseUrl");
    expect(spy.mock.calls.some((args) => String(args[0]).includes("https://test.atlassian.net"))).toBe(true);
    spy.mockRestore();
  });

  test("prints the value for a readonly key (accountId)", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    await getConfig("accountId");
    expect(spy.mock.calls.some((args) => String(args[0]).includes("acc1"))).toBe(true);
    spy.mockRestore();
  });

  test("logs error for unknown key", async () => {
    await getConfig("bogusKey");
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining("Unknown config key"));
  });
});

// ---------------------------------------------------------------------------
// setConfig — flat keys
// ---------------------------------------------------------------------------

describe("setConfig — flat key", () => {
  test("prompts with p.text and saves updated baseUrl", async () => {
    mockText.mockResolvedValueOnce("https://new.atlassian.net");
    await setConfig("baseUrl");
    expect(mockText).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://new.atlassian.net" })
    );
  });

  test("strips trailing slash from baseUrl on save", async () => {
    mockText.mockResolvedValueOnce("https://new.atlassian.net/");
    await setConfig("baseUrl");
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://new.atlassian.net" })
    );
  });

  test("prompts with p.select for authType and saves", async () => {
    mockSelect.mockResolvedValueOnce("datacenter");
    await setConfig("authType");
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ authType: "datacenter" })
    );
  });

  test("pre-populates p.text with the current value", async () => {
    mockText.mockResolvedValueOnce("test@example.com");
    await setConfig("email");
    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "test@example.com" })
    );
  });

  test("logs success after saving a flat key", async () => {
    mockText.mockResolvedValueOnce("https://new.atlassian.net");
    await setConfig("baseUrl");
    expect(mockLogSuccess).toHaveBeenCalledWith(expect.stringContaining("baseUrl"));
  });
});

// ---------------------------------------------------------------------------
// setConfig — sub-keys (tableWidths.*)
// ---------------------------------------------------------------------------

describe("setConfig — tableWidths sub-key", () => {
  test("prompts with p.text and saves to the correct column", async () => {
    mockText.mockResolvedValueOnce("20");
    await setConfig("tableWidths.sprint");
    expect(mockText).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tableWidths: expect.objectContaining({ sprint: 20 }) })
    );
  });

  test("pre-populates with the default when tableWidths is not set", async () => {
    mockLoadConfig.mockImplementationOnce(() => ({ ...BASE_CONFIG, tableWidths: undefined }));
    mockText.mockResolvedValueOnce("16");
    await setConfig("tableWidths.sprint");
    // Default for sprint is 16
    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "16" })
    );
  });

  test("pre-populates with stored value when tableWidths is set", async () => {
    mockLoadConfig.mockImplementationOnce(() => ({ ...BASE_CONFIG, tableWidths: { sprint: 24 } }));
    mockText.mockResolvedValueOnce("24");
    await setConfig("tableWidths.sprint");
    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "24" })
    );
  });

  test("does not overwrite other column widths when setting one column", async () => {
    mockLoadConfig.mockImplementationOnce(() => ({
      ...BASE_CONFIG,
      tableWidths: { key: 10, sprint: 20 },
    }));
    mockText.mockResolvedValueOnce("30");
    await setConfig("tableWidths.summary");
    const saved = mockSaveConfig.mock.calls[0]?.[0] as Config;
    expect(saved.tableWidths?.key).toBe(10);
    expect(saved.tableWidths?.sprint).toBe(20);
    expect(saved.tableWidths?.summary).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// setConfig — namespace key (tableWidths loop)
// ---------------------------------------------------------------------------

describe("setConfig — tableWidths namespace", () => {
  test("runs the loop editor and saves all column widths on Done", async () => {
    // Loop: select sprint → update → Done
    mockSelect
      .mockResolvedValueOnce("tableWidths.sprint")
      .mockResolvedValueOnce("__done__");
    mockText.mockResolvedValueOnce("25");

    await setConfig("tableWidths");

    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tableWidths: expect.objectContaining({ sprint: 25 }) })
    );
  });

  test("loop calls back into promptForKey for each selected column", async () => {
    // Select key column then done
    mockSelect
      .mockResolvedValueOnce("tableWidths.key")
      .mockResolvedValueOnce("__done__");
    mockText.mockResolvedValueOnce("15");

    await setConfig("tableWidths");

    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("key") })
    );
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tableWidths: expect.objectContaining({ key: 15 }) })
    );
  });

  test("loop preserves other columns when only one is edited", async () => {
    mockLoadConfig.mockImplementationOnce(() => ({
      ...BASE_CONFIG,
      tableWidths: { key: 10, type: 8, status: 20, sprint: 16, estimate: 8, summary: 60 },
    }));

    mockSelect
      .mockResolvedValueOnce("tableWidths.key")
      .mockResolvedValueOnce("__done__");
    mockText.mockResolvedValueOnce("13");

    await setConfig("tableWidths");

    const saved = mockSaveConfig.mock.calls[0]?.[0] as Config;
    expect(saved.tableWidths?.key).toBe(13);
    expect(saved.tableWidths?.type).toBe(8);
    expect(saved.tableWidths?.sprint).toBe(16);
  });

  test("loop menu options are the dot-notation sub-keys", async () => {
    const optionsPromise = captureSelectAndReturn("__done__");
    await setConfig("tableWidths");
    const options = await optionsPromise;
    const values = options.map((o: { value: string }) => o.value);
    expect(values).toContain("tableWidths.key");
    expect(values).toContain("tableWidths.sprint");
    expect(values).toContain("tableWidths.summary");
    expect(values).toContain("__done__");
    // Sub-keys only — no flat keys in the loop menu
    expect(values).not.toContain("baseUrl");
  });
});

// ---------------------------------------------------------------------------
// setConfig — non-interactive (value passed directly)
// ---------------------------------------------------------------------------

describe("setConfig — non-interactive value", () => {
  test("sets a flat string key without prompting", async () => {
    await setConfig("baseUrl", "https://direct.atlassian.net");
    expect(mockText).not.toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://direct.atlassian.net" })
    );
    expect(mockLogSuccess).toHaveBeenCalledWith(expect.stringContaining("baseUrl"));
  });

  test("parses JSON value for a namespace key (tableWidths)", async () => {
    const widths = { key: 10, type: 8, status: 20, sprint: 14, estimate: 6, summary: 50 };
    await setConfig("tableWidths", JSON.stringify(widths));
    expect(mockText).not.toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tableWidths: widths })
    );
  });

  test("parses JSON number for a sub-key (tableWidths.sprint)", async () => {
    await setConfig("tableWidths.sprint", "25");
    expect(mockText).not.toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tableWidths: expect.objectContaining({ sprint: 25 }) })
    );
  });

  test("treats non-JSON string as plain string value", async () => {
    await setConfig("jiraPat", "$MY_TOKEN");
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ jiraPat: "$MY_TOKEN" })
    );
  });
});

// ---------------------------------------------------------------------------
// setConfig — error cases
// ---------------------------------------------------------------------------

describe("setConfig — errors", () => {
  test("logs error for readonly key (accountId)", async () => {
    await setConfig("accountId");
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining("read-only"));
  });

  test("logs error for unknown key", async () => {
    await setConfig("bogusKey");
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining("Unknown settable key"));
  });
});

// ---------------------------------------------------------------------------
// setConfig — interactive menu (no key)
// ---------------------------------------------------------------------------

describe("setConfig — interactive menu", () => {
  test("menu shows only top-level keys (no dot-notation sub-keys)", async () => {
    const optionsPromise = captureSelectAndReturn("baseUrl");
    mockText.mockResolvedValueOnce("https://new.atlassian.net");
    await setConfig();
    const options = await optionsPromise;
    const values = options.map((o: { value: string }) => o.value);
    expect(values).toContain("baseUrl");
    expect(values).toContain("tableWidths");
    // Sub-keys must not appear in the top-level menu
    expect(values).not.toContain("tableWidths.key");
    expect(values).not.toContain("tableWidths.sprint");
  });

  test("after selecting a flat key from the menu, prompts and saves it", async () => {
    mockSelect.mockResolvedValueOnce("email");
    mockText.mockResolvedValueOnce("new@example.com");
    await setConfig();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@example.com" })
    );
  });

  test("hints show current values for flat keys", async () => {
    const optionsPromise = captureSelectAndReturn("baseUrl");
    mockText.mockResolvedValueOnce("https://new.atlassian.net");
    await setConfig();
    const options = await optionsPromise;
    const baseUrlOption = options.find((o: { value: string }) => o.value === "baseUrl");
    expect(baseUrlOption?.hint).toBe("https://test.atlassian.net");
  });
});

// ---------------------------------------------------------------------------
// runConfig — setup wizard
// ---------------------------------------------------------------------------

describe("runConfig — setup wizard", () => {
  test("cloud: prompts for baseUrl, authType, email, jiraPat, tempoPat", async () => {
    mockText
      .mockResolvedValueOnce("https://new.atlassian.net") // baseUrl
      .mockResolvedValueOnce("new@example.com")           // email
      .mockResolvedValueOnce("$JIRA_PAT")                 // jiraPat
      .mockResolvedValueOnce("$TEMPO_PAT");               // tempoPat
    mockSelect.mockResolvedValueOnce("cloud");            // authType

    await runConfig();

    expect(mockText).toHaveBeenCalledTimes(4);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ authType: "cloud", email: "new@example.com" })
    );
  });

  test("datacenter: skips email prompt", async () => {
    mockText
      .mockResolvedValueOnce("https://new.atlassian.net") // baseUrl
      .mockResolvedValueOnce("$JIRA_PAT")                 // jiraPat
      .mockResolvedValueOnce("$TEMPO_PAT");               // tempoPat
    mockSelect.mockResolvedValueOnce("datacenter");       // authType

    await runConfig();

    // text called 3 times (no email), select called once (authType)
    expect(mockText).toHaveBeenCalledTimes(3);
    const saved = mockSaveConfig.mock.calls[0]?.[0] as Config;
    expect(saved.authType).toBe("datacenter");
    expect(saved.email).toBeUndefined();
  });

  test("saves verified accountId from getMyself", async () => {
    mockText
      .mockResolvedValueOnce("https://new.atlassian.net")
      .mockResolvedValueOnce("new@example.com")
      .mockResolvedValueOnce("$JIRA_PAT")
      .mockResolvedValueOnce("$TEMPO_PAT");
    mockSelect.mockResolvedValueOnce("cloud");

    await runConfig();

    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-new" })
    );
  });

  test("pre-populates prompts from existing config", async () => {
    mockLoadConfig.mockImplementationOnce(() => ({
      ...BASE_CONFIG,
      baseUrl: "https://existing.atlassian.net",
    }));

    mockText
      .mockResolvedValueOnce("https://existing.atlassian.net")
      .mockResolvedValueOnce("test@example.com")
      .mockResolvedValueOnce("$JIRA_PAT")
      .mockResolvedValueOnce("$TEMPO_PAT");
    mockSelect.mockResolvedValueOnce("cloud");

    await runConfig();

    // The first text call (baseUrl) should have the existing value pre-filled
    expect(mockText.mock.calls[0]?.[0]).toMatchObject({
      initialValue: "https://existing.atlassian.net",
    });
  });
});
