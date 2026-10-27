import { beforeEach, describe, expect, it, vi } from "vitest";
const { getConfig, hasFeature } = vi.hoisted(() => ({ getConfig: vi.fn(), hasFeature: vi.fn() }));
vi.mock("./settings/config", () => ({ getConfig }));
vi.mock("./license/gate", () => ({ hasFeature }));
import { DEFAULT_BRAND, getInstanceBrand } from "./brand";

beforeEach(() => {
  getConfig.mockResolvedValue(JSON.stringify({ ...DEFAULT_BRAND, name: "Orchard" }));
  hasFeature.mockResolvedValue(true);
});
describe("instance identity resolver", () => {
  it("reads licensed identity from the settings resolver", async () => {
    expect((await getInstanceBrand()).name).toBe("Orchard");
    expect(getConfig).toHaveBeenCalledWith("INSTANCE_BRANDING");
    expect(hasFeature).toHaveBeenCalledWith("white_label");
  });
  it("uses the default without a configuration", async () => {
    getConfig.mockResolvedValue("");
    expect(await getInstanceBrand()).toBe(DEFAULT_BRAND);
  });
  it("uses the default without entitlement", async () => {
    hasFeature.mockResolvedValue(false);
    expect(await getInstanceBrand()).toBe(DEFAULT_BRAND);
  });
  it.each(["broken", '{"name":"Orchard"}'])("uses the default for an invalid configuration %s", async (value) => {
    getConfig.mockResolvedValue(value);
    expect(await getInstanceBrand()).toBe(DEFAULT_BRAND);
  });
  it("uses the default when entitlement cannot be resolved", async () => {
    hasFeature.mockRejectedValue(new Error("offline"));
    expect(await getInstanceBrand()).toBe(DEFAULT_BRAND);
  });
});
