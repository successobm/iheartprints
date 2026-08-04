import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { ChatApp } from "./ChatApp";
import { useIsClient } from "./use-is-client";

describe("ChatApp server render / hydration gate", () => {
  it("server-renders a stable loading shell without Start over", () => {
    const html = renderToString(createElement(ChatApp));

    assert.match(html, /iHeartPrints/);
    assert.match(html, /Print-Ready Artwork/);
    assert.match(html, /Starting conversation/);
    assert.doesNotMatch(html, /Start over/);
    assert.doesNotMatch(html, /What are we printing today/);
  });

  it("useIsClient stays false on the server snapshot path", () => {
    function Probe() {
      const isClient = useIsClient();
      return createElement("span", null, isClient ? "client" : "server");
    }

    const html = renderToString(createElement(Probe));
    assert.equal(html, "<span>server</span>");
  });
});
