import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthenticate = vi.fn();
const mockAuthenticateWithScope = vi.fn();

vi.mock("@/lib/auth", () => ({
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
  authenticateWithScope: (...args: unknown[]) => mockAuthenticateWithScope(...args),
}));

vi.mock("@/lib/content/service", () => ({
  listContent: vi.fn(),
  createContent: vi.fn(),
  getContent: vi.fn(),
  patchContent: vi.fn(),
  deleteContent: vi.fn(),
  listPosts: vi.fn(),
  createPost: vi.fn(),
  getPost: vi.fn(),
  patchPost: vi.fn(),
  deletePost: vi.fn(),
}));
vi.mock("@/lib/content/publish", () => ({ publishPost: vi.fn() }));
vi.mock("@/lib/brands/service", () => ({
  listBrands: vi.fn(),
  createBrand: vi.fn(),
  getBrand: vi.fn(),
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
}));
vi.mock("@/lib/brands/resolve", () => ({ resolveBrandSlots: vi.fn() }));
vi.mock("@/lib/media/service", () => ({
  registerByUrl: vi.fn(),
  registerKnownMedia: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/media/probe", () => ({ defaultProbe: vi.fn() }));

import * as contentList from "@/server/handlers/v1/content/route";
import * as contentItem from "@/server/handlers/v1/content/[contentId]/route";
import * as postsList from "@/server/handlers/v1/posts/route";
import * as postItem from "@/server/handlers/v1/posts/[postId]/route";
import * as postPublish from "@/server/handlers/v1/posts/[postId]/publish/route";
import * as brandsList from "@/server/handlers/v1/brands/route";
import * as brandItem from "@/server/handlers/v1/brands/[brandKey]/route";
import * as brandChannels from "@/server/handlers/v1/brands/[brandKey]/channels/route";
import * as media from "@/server/handlers/v1/media/route";

type ScopeCase = {
  method: string;
  path: string;
  scope: string;
  invoke: (request: Request) => Promise<Response>;
};

const contentContext = { params: Promise.resolve({ contentId: "content-1" }) };
const postContext = { params: Promise.resolve({ postId: "post-1" }) };
const brandContext = { params: Promise.resolve({ brandKey: "brand-1" }) };

const cases: ScopeCase[] = [
  { method: "GET", path: "/content", scope: "content:read", invoke: contentList.GET },
  { method: "POST", path: "/content", scope: "content:write", invoke: contentList.POST },
  { method: "GET", path: "/content/content-1", scope: "content:read", invoke: (request) => contentItem.GET(request, contentContext) },
  { method: "PATCH", path: "/content/content-1", scope: "content:write", invoke: (request) => contentItem.PATCH(request, contentContext) },
  { method: "DELETE", path: "/content/content-1", scope: "content:write", invoke: (request) => contentItem.DELETE(request, contentContext) },
  { method: "GET", path: "/posts", scope: "posts:read", invoke: postsList.GET },
  { method: "POST", path: "/posts", scope: "posts:write", invoke: postsList.POST },
  { method: "GET", path: "/posts/post-1", scope: "posts:read", invoke: (request) => postItem.GET(request, postContext) },
  { method: "PATCH", path: "/posts/post-1", scope: "posts:write", invoke: (request) => postItem.PATCH(request, postContext) },
  { method: "DELETE", path: "/posts/post-1", scope: "posts:write", invoke: (request) => postItem.DELETE(request, postContext) },
  { method: "POST", path: "/posts/post-1/publish", scope: "posts:write", invoke: (request) => postPublish.POST(request, postContext) },
  { method: "GET", path: "/brands", scope: "brands:read", invoke: brandsList.GET },
  { method: "POST", path: "/brands", scope: "brands:write", invoke: brandsList.POST },
  { method: "PATCH", path: "/brands/brand-1", scope: "brands:write", invoke: (request) => brandItem.PATCH(request, brandContext) },
  { method: "DELETE", path: "/brands/brand-1", scope: "brands:write", invoke: (request) => brandItem.DELETE(request, brandContext) },
  { method: "GET", path: "/brands/brand-1/channels", scope: "brands:read", invoke: (request) => brandChannels.GET(request, brandContext) },
  { method: "POST", path: "/media", scope: "media:write", invoke: media.POST },
];

describe("publishing handler scope contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(null);
    mockAuthenticateWithScope.mockResolvedValue(null);
  });

  it.each(cases)("$method $path requires $scope", async ({ method, path, scope, invoke }) => {
    const request = new Request(`http://x/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });

    const response = await invoke(request);

    expect(response.status).toBe(401);
    expect(mockAuthenticateWithScope).toHaveBeenCalledOnce();
    expect(mockAuthenticateWithScope).toHaveBeenCalledWith(request, scope);
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});
