import { describe, expect, it } from "vitest";
import type { GraphAction } from "./actions";
import { layoutMenu } from "./menuLayout";

const action = (id: string, title = id): GraphAction => ({
  id,
  title,
  description: "",
  confirmLabel: title,
  run: { type: "ui", run: () => undefined },
});

describe("layoutMenu", () => {
  const items = layoutMenu(
    ["copy", "reset-hard", "new-tag", "checkout", "revert", "new-branch", "reset-soft", "reset-mixed", "hide-ref"].map((id) =>
      action(id),
    ),
    "main",
  );
  const ids = items.map((i) => i.id);

  it("orders entries by group with a divider between groups", () => {
    const actions = ids.filter((id) => !id.startsWith("sep-"));
    expect(actions).toEqual(["checkout", "new-branch", "reset", "revert", "copy", "new-tag", "hide-ref"]);
    expect(ids.filter((id) => id.startsWith("sep-"))).toHaveLength(4);
    expect(ids[0]).toBe("checkout");
    expect(ids[ids.length - 1]).toBe("hide-ref");
  });

  it("folds the three resets into one flyout named after the branch", () => {
    const reset = items.find((i) => i.id === "reset");
    expect(reset && "label" in reset && reset.label).toBe("Reset main to this commit");
    const sub = reset && "submenu" in reset ? reset.submenu : undefined;
    expect(sub?.map((i) => i.id)).toEqual(["reset-hard", "reset-soft", "reset-mixed"]);
    expect(sub?.[0]).toMatchObject({ danger: true });
  });

  it("starts with no divider and never doubles one", () => {
    expect(layoutMenu([action("checkout")], null)).toHaveLength(1);
    expect(layoutMenu([], null)).toEqual([]);
  });
});
