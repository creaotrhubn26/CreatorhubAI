import { describe, it, expect } from "vitest";
import {
  fileHref, absolutePath, ancestorDirs, looksLikeDirectoryPath, mostSpecificContainingWorkspace,
} from "./fileLink";

describe("fileHref", () => {
  it("encodes the path and carries a line only when one is actually known", () => {
    expect(fileHref("/home/u/a b/x.ts")).toBe("/files?path=%2Fhome%2Fu%2Fa+b%2Fx.ts");
    expect(fileHref("/home/u/x.ts", 42)).toBe("/files?path=%2Fhome%2Fu%2Fx.ts&line=42");
  });

  it("carries a real originating session only when the caller names one", () => {
    expect(fileHref("/w/x.ts", 7, "s1")).toBe("/files?path=%2Fw%2Fx.ts&line=7&session=s1");
    expect(fileHref("/w/x.ts", 7)).not.toContain("session=");
  });

  it("never invents a line number from a missing or nonsensical one", () => {
    for (const line of [undefined, 0, -3, NaN]) {
      expect(fileHref("/x.ts", line as number)).not.toContain("line=");
    }
  });
});

describe("looksLikeDirectoryPath", () => {
  it("recognises the spellings a doc-graph node uses for a directory", () => {
    // A service node for the repo root records ".", and "Open file" on it
    // would be an affordance that cannot work.
    for (const p of [".", "./", "src/", "web/src/..", "a/b/."]) {
      expect(looksLikeDirectoryPath(p)).toBe(true);
    }
  });

  it("leaves ordinary file paths alone", () => {
    for (const p of ["a.ts", "docs/README.md", "src/.hidden", "..gitignore"]) {
      expect(looksLikeDirectoryPath(p)).toBe(false);
    }
  });
});

describe("absolutePath", () => {
  it("joins a repo-relative path onto the workspace", () => {
    expect(absolutePath("/w", "src/a.ts")).toBe("/w/src/a.ts");
    expect(absolutePath("/w/", "./src/a.ts")).toBe("/w/src/a.ts");
  });

  it("leaves an already-absolute path alone", () => {
    expect(absolutePath("/w", "/other/a.ts")).toBe("/other/a.ts");
  });
});

describe("mostSpecificContainingWorkspace", () => {
  it("chooses the deepest known workspace when workspaces are nested", () => {
    expect(mostSpecificContainingWorkspace(["/w", "/w/packages/app"], "/w/packages/app/src/a.ts"))
      .toBe("/w/packages/app");
  });

  it("uses path boundaries rather than string prefixes", () => {
    expect(mostSpecificContainingWorkspace(["/w"], "/workspace/a.ts")).toBeUndefined();
  });
});

describe("ancestorDirs", () => {
  it("lists root through the file's parent", () => {
    expect(ancestorDirs("/w", "/w/src/deep/a.ts")).toEqual(["/w", "/w/src", "/w/src/deep"]);
  });

  it("is just the root for a file directly inside it", () => {
    expect(ancestorDirs("/w", "/w/a.ts")).toEqual(["/w"]);
  });

  it("returns nothing for a target outside the root — there is nothing honest to expand", () => {
    expect(ancestorDirs("/w", "/elsewhere/a.ts")).toEqual([]);
    // A sibling with the root as a string prefix is NOT inside it.
    expect(ancestorDirs("/w", "/workspace-other/a.ts")).toEqual([]);
  });
});
