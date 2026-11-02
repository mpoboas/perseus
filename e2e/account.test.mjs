// End-to-end tests for the signed-in account: browsing its repositories, cloning (also through a
// fork) and creating a repository that is published at once. GitHub is played by a small server on
// this machine (the app only talks to it because the tests redirect it, see `test_origin` in
// account_commands.rs), and every "remote" is a bare repository in a temporary folder, so nothing
// here touches a real account.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { git, launch, makeFixture, scratchDir } from "./harness.mjs";

/** Waits until `check` is true, for state that git or the file system settles a moment after a click. */
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bare = (root, name) => {
  const dir = join(root, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
};

/** A GitHub that knows `acme/widgets` (private) and `tester/own`, and creates what it is asked to. */
function fakeGitHub({ widgets, created, forked }) {
  const calls = [];
  const repo = (full, url, isPrivate) => ({
    full_name: full,
    owner: { login: full.split("/")[0] },
    name: full.split("/")[1],
    description: `${full} on the fake host`,
    private: isPrivate,
    fork: false,
    clone_url: url,
    ssh_url: "",
    html_url: `https://example.test/${full}`,
  });
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const path = new URL(req.url, "http://fake").pathname;
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method, path, body });
      const send = (code, value) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const key = `${req.method} ${path}`;
      if (key === "GET /api/v3/user/repos") return send(200, [repo("acme/widgets", widgets, true), repo("tester/own", widgets, false)]);
      if (key === "GET /api/v3/repos/acme/widgets") return send(200, repo("acme/widgets", widgets, true));
      if (key === "POST /api/v3/repos/acme/widgets/forks") return send(202, repo("tester/widgets", forked, false));
      if (key === "GET /api/v3/user") return send(200, { login: "tester" });
      if (key === "GET /api/v3/user/orgs") return send(200, [{ login: "acme" }]);
      if (key === "POST /api/v3/user/repos" || key === "POST /api/v3/orgs/acme/repos") {
        if (body.name === "taken") return send(422, { message: "name already exists on this account" });
        const owner = path.includes("/orgs/") ? "acme" : "tester";
        return send(201, repo(`${owner}/${body.name}`, created, body.private));
      }
      send(404, { message: `no route for ${key}` });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ calls, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })),
  );
}

describe("Perseus using the signed-in account", () => {
  let app;
  let page;
  let host;
  let root;

  /** The folder the dialogs start in (the one used last, which the app keeps in its data folder). */
  const startIn = (name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(app.appdata, "last-folder.txt"), dir);
    return dir;
  };

  before(async () => {
    root = scratchDir("perseus-account-");
    const source = makeFixture(join(root, "src"));
    const widgets = bare(root, "widgets");
    git(source, "push", "-q", widgets, "main");
    host = await fakeGitHub({ widgets, created: bare(root, "created"), forked: bare(root, join("fork", "widgets")) });
    git(source, "push", "-q", join(root, "fork", "widgets.git"), "main");
    app = await launch({ port: 9456, env: { PERSEUS_TEST_HOST_ORIGIN: host.origin } });
    page = app.page;
  });

  after(async () => {
    host?.close();
    await app?.stop();
  });

  it("lists the account's repositories under their owners and filters them as you type", async () => {
    startIn("clones");
    await page.getByRole("button", { name: "Clone a repository" }).click();
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    const list = page.getByRole("listbox", { name: "Repositories" });
    await list.getByRole("group", { name: "acme" }).getByRole("option", { name: /widgets/ }).waitFor();
    await list.getByRole("group", { name: "tester" }).getByRole("option", { name: /own/ }).waitFor();

    await page.getByLabel("Repository to clone").fill("own");
    await list.getByRole("option", { name: /widgets/ }).waitFor({ state: "detached" });
    await list.getByRole("option", { name: /own/ }).waitFor();
    await page.getByLabel("Repository to clone").fill("");
  });

  it("clones a repository of the account into the chosen folder", async () => {
    await page.getByRole("option", { name: /widgets/ }).click();
    await page.getByText("Clones acme/widgets as it is on GitHub.com.").waitFor();
    await page.getByRole("button", { name: "Clone the repo" }).click();
    await page.locator(".repo-tab", { hasText: "widgets" }).waitFor({ timeout: 30000 });
    const clone = join(root, "clones", "widgets");
    assert.ok(existsSync(join(clone, "a.txt")), "the files are there");
    assert.equal(git(clone, "remote").trim(), "origin", "a plain clone has just origin");
  });

  it("forks first when asked, clones the fork and keeps the original as upstream", async () => {
    startIn("forks");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("clone a repository");
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    await page.getByRole("option", { name: /widgets/ }).click();
    await page.getByLabel(/Fork it to my account first/).check();
    await page.getByRole("button", { name: "Fork and clone" }).click();
    await until(() => existsSync(join(root, "forks", "widgets", "a.txt")), "the fork is cloned");

    const clone = join(root, "forks", "widgets");
    assert.equal(git(clone, "remote", "get-url", "origin").trim(), join(root, "fork", "widgets.git"), "origin is the fork");
    assert.equal(git(clone, "remote", "get-url", "upstream").trim(), join(root, "widgets.git"), "upstream is the original");
    const forks = host.calls.filter((c) => c.method === "POST" && c.path.endsWith("/forks"));
    assert.equal(forks.length, 1, "the host was asked for one fork");
    assert.deepEqual(forks[0].body, {}, "with the defaults: my account, the same name");
  });

  it("does not offer to fork what is already yours", async () => {
    startIn("again");
    await page.getByRole("button", { name: "Switch repository" }).click();
    await page.getByRole("button", { name: "Clone a repository…" }).click();
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    await page.getByRole("option", { name: /own/ }).click();
    await page.getByText("This repository is already yours.").waitFor();
    assert.equal(await page.getByLabel(/Fork it to my account first/).isDisabled(), true);
    await page.keyboard.press("Escape");
  });

  it("creates a local repository with a README", async () => {
    const parent = startIn("created-here");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("create a new repository");
    await page.keyboard.press("Enter");
    await page.getByLabel("Name", { exact: true }).fill("notes");
    await page.getByLabel("Description (optional)").fill("Things to remember");
    await page.getByRole("button", { name: "Create the repository" }).click();
    await page.locator(".repo-tab", { hasText: "notes" }).waitFor({ timeout: 30000 });

    const dir = join(parent, "notes");
    assert.equal(git(dir, "log", "--format=%s").trim(), "Initial commit");
    assert.match(readFileSync(join(dir, "README.md"), "utf8").replace(/\r\n/g, "\n"), /^# notes\n\nThings to remember\n$/);
    assert.equal(git(dir, "remote").trim(), "", "nothing was published");
  });

  it("creates a repository in an organization and publishes its first commit", async () => {
    const parent = startIn("published");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("create a new repository");
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    await page.getByLabel("Owner").selectOption("acme");
    await page.getByLabel("Name", { exact: true }).fill("shipped");
    await page.getByRole("button", { name: "Create and publish to GitHub.com" }).click();
    await page.getByText("Published shipped").waitFor({ timeout: 30000 });

    const creates = host.calls.filter((c) => c.method === "POST" && c.path === "/api/v3/orgs/acme/repos");
    assert.equal(creates.length, 1, "created in the organization");
    assert.deepEqual(creates[0].body, { name: "shipped", description: "", private: true, auto_init: false });

    const dir = join(parent, "shipped");
    assert.equal(git(dir, "remote", "get-url", "origin").trim(), join(root, "created.git"));
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");
    assert.equal(git(join(root, "created.git"), "log", "--format=%s", "main").trim(), "Initial commit", "the first commit is on the host");
  });

  it("keeps the repository and says so when the host refuses to create it", async () => {
    const parent = startIn("refused");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("create a new repository");
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    await page.getByLabel("Name", { exact: true }).fill("taken");
    await page.getByRole("button", { name: "Create and publish to GitHub.com" }).click();
    await page.getByText("Created taken, with a problem").waitFor({ timeout: 30000 });
    await page.getByText(/name already exists on this account/).waitFor();
    assert.ok(existsSync(join(parent, "taken", ".git")), "the local repository is there and open");
    await page.locator(".repo-tab", { hasText: "taken" }).waitFor();
  });

  it("will not publish under a name the host would refuse", async () => {
    startIn("badnames");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("create a new repository");
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: "GitHub.com" }).click();
    await page.getByLabel("Name", { exact: true }).fill("my project");
    await page.getByText(/no spaces/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create and publish to GitHub.com" }).isDisabled(), true);
    await page.getByRole("tab", { name: "Local only" }).click();
    assert.equal(await page.getByRole("button", { name: "Create the repository" }).isDisabled(), false, "a local folder may have a space");
    await page.keyboard.press("Escape");
  });
});
