export const LIVE_DESIGN_BRIDGE_CLIENT = String.raw`(function () {
  "use strict";
  if (["localhost", "127.0.0.1", "::1", "[::1]"].indexOf(location.hostname) === -1) return;
  if (window.__GLIMMER_LIVE_DESIGN_BRIDGE__) return;
  window.__GLIMMER_LIVE_DESIGN_BRIDGE__ = true;

  var script = document.currentScript;
  var configuredParent = script && script.getAttribute("data-glimmer-parent");
  var namespace = "glimmer-live-design";
  var channel = null;
  var parentWindow = null;
  var parentOrigin = null;
  var selecting = false;
  var hovered = null;
  var selectedElement = null;
  var overlay = null;
  var label = null;
  var originals = new Map();
  var structurePreview = null;
  var responsivePreview = null;
  var styleRulePreview = null;
  var resizeEnabled = false;
  var resizeHandles = [];
  var resizeState = null;
  var secondaryOverlays = [];
  var visibilityOriginals = new Map();
  var guideX = null;
  var guideY = null;
  var suppressMutationsUntil = 0;
  var knownParents = [
    "http://127.0.0.1:5183",
    "http://localhost:5183",
    "tauri://localhost",
    "https://tauri.localhost"
  ];

  function allowedParent(origin) {
    if (!configuredParent) return knownParents.indexOf(origin) !== -1;
    if (origin !== configuredParent) return false;
    if (origin === "tauri://localhost" || origin === "https://tauri.localhost") return true;
    try {
      var parsedParent = new URL(origin);
      return (
        parsedParent.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1", "[::1]"].indexOf(parsedParent.hostname) !== -1 &&
        !parsedParent.username &&
        !parsedParent.password
      );
    } catch (_error) {
      return false;
    }
  }

  function send(type, payload) {
    if (!channel || !parentWindow || !parentOrigin) return;
    parentWindow.postMessage(
      Object.assign({ namespace: namespace, type: type, channel: channel }, payload || {}),
      parentOrigin
    );
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("data-glimmer-overlay", "true");
    overlay.style.cssText =
      "position:fixed;display:none;pointer-events:none;z-index:2147483646;border:2px solid #72d6cc;background:rgba(114,214,204,.10);box-sizing:border-box;";
    label = document.createElement("div");
    label.style.cssText =
      "position:absolute;left:-2px;top:-26px;max-width:320px;height:24px;padding:4px 7px;background:#121317;color:#e9fffc;border:1px solid #72d6cc;border-radius:4px;font:11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;";
    overlay.appendChild(label);
    [
      ["move", "right:-7px;top:-7px;cursor:move;"],
      ["right", "right:-7px;top:50%;transform:translateY(-50%);cursor:ew-resize;"],
      ["bottom", "left:50%;bottom:-7px;transform:translateX(-50%);cursor:ns-resize;"],
      ["corner", "right:-7px;bottom:-7px;cursor:nwse-resize;"]
    ].forEach(function (definition) {
      var handle = document.createElement("button");
      handle.type = "button";
      handle.setAttribute("data-glimmer-resize-handle", definition[0]);
      handle.setAttribute("aria-label", "Resize selected element " + definition[0]);
      handle.style.cssText =
        "position:absolute;display:none;width:12px;height:12px;padding:0;border:2px solid #101315;border-radius:3px;background:#72d6cc;box-sizing:border-box;pointer-events:auto;" +
        definition[1];
      handle.addEventListener("pointerdown", beginResize, true);
      overlay.appendChild(handle);
      resizeHandles.push(handle);
    });
    guideX = document.createElement("div");
    guideX.setAttribute("data-glimmer-guide", "x");
    guideX.style.cssText =
      "position:fixed;display:none;pointer-events:none;z-index:2147483645;top:0;bottom:0;width:1px;background:#ff5fd1;";
    guideY = document.createElement("div");
    guideY.setAttribute("data-glimmer-guide", "y");
    guideY.style.cssText =
      "position:fixed;display:none;pointer-events:none;z-index:2147483645;left:0;right:0;height:1px;background:#ff5fd1;";
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(guideX);
    document.documentElement.appendChild(guideY);
  }

  function positionOverlay(element) {
    ensureOverlay();
    var rect = element.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = Math.max(0, rect.left) + "px";
    overlay.style.top = Math.max(0, rect.top) + "px";
    overlay.style.width = Math.max(0, Math.min(rect.width, window.innerWidth)) + "px";
    overlay.style.height = Math.max(0, Math.min(rect.height, window.innerHeight)) + "px";
    label.textContent = selectorFor(element);
    resizeHandles.forEach(function (handle) {
      handle.style.display = resizeEnabled && element === selectedElement ? "block" : "none";
    });
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
    hovered = null;
  }

  function clearSecondaryOverlays() {
    secondaryOverlays.forEach(function (entry) {
      if (entry.overlay.parentNode) entry.overlay.parentNode.removeChild(entry.overlay);
    });
    secondaryOverlays = [];
  }

  function positionSecondaryOverlays() {
    secondaryOverlays.forEach(function (entry) {
      var rect = entry.element.getBoundingClientRect();
      entry.overlay.style.left = Math.max(0, rect.left) + "px";
      entry.overlay.style.top = Math.max(0, rect.top) + "px";
      entry.overlay.style.width = Math.max(0, Math.min(rect.width, window.innerWidth)) + "px";
      entry.overlay.style.height = Math.max(0, Math.min(rect.height, window.innerHeight)) + "px";
    });
  }

  function highlightMany(selectors) {
    clearSecondaryOverlays();
    if (!Array.isArray(selectors)) return;
    selectors.slice(0, 50).forEach(function (selector) {
      if (typeof selector !== "string" || selector.length > 1000) return;
      var element;
      try {
        element = document.querySelector(selector);
      } catch (_error) {
        element = null;
      }
      if (!element || element === selectedElement) return;
      var secondary = document.createElement("div");
      secondary.setAttribute("data-glimmer-overlay", "true");
      secondary.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483644;border:1px dashed #72d6cc;background:rgba(114,214,204,.04);box-sizing:border-box;";
      document.documentElement.appendChild(secondary);
      secondaryOverlays.push({ element: element, overlay: secondary });
    });
    positionSecondaryOverlays();
  }

  function beginResize(event) {
    if (!resizeEnabled || !selectedElement || !(event.currentTarget instanceof Element)) return;
    var rect = selectedElement.getBoundingClientRect();
    var selector = selectorFor(selectedElement);
    rememberOriginal(selector, selectedElement);
    resizeState = {
      direction: event.currentTarget.getAttribute("data-glimmer-resize-handle"),
      element: selectedElement,
      selector: selector,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      startLeft: parseFloat(getComputedStyle(selectedElement).left) || 0,
      startTop: parseFloat(getComputedStyle(selectedElement).top) || 0,
      startCenterX: rect.left + rect.width / 2,
      startCenterY: rect.top + rect.height / 2
    };
    event.preventDefault();
    event.stopPropagation();
    send("resize-start", { selector: selector, width: rect.width, height: rect.height });
  }

  function resizeMove(event) {
    if (!resizeState) return;
    if (resizeState.direction === "move") {
      var deltaX = event.clientX - resizeState.startX;
      var deltaY = event.clientY - resizeState.startY;
      var snapX = Math.abs(resizeState.startCenterX + deltaX - window.innerWidth / 2) <= 8;
      var snapY = Math.abs(resizeState.startCenterY + deltaY - window.innerHeight / 2) <= 8;
      if (snapX) deltaX += window.innerWidth / 2 - (resizeState.startCenterX + deltaX);
      if (snapY) deltaY += window.innerHeight / 2 - (resizeState.startCenterY + deltaY);
      var left = Math.round(resizeState.startLeft + deltaX);
      var top = Math.round(resizeState.startTop + deltaY);
      suppressMutationsUntil = Date.now() + 350;
      if (getComputedStyle(resizeState.element).position === "static") {
        resizeState.element.style.position = "relative";
      }
      resizeState.element.style.left = left + "px";
      resizeState.element.style.top = top + "px";
      if (guideX) {
        guideX.style.display = snapX ? "block" : "none";
        guideX.style.left = window.innerWidth / 2 + "px";
      }
      if (guideY) {
        guideY.style.display = snapY ? "block" : "none";
        guideY.style.top = window.innerHeight / 2 + "px";
      }
      positionOverlay(resizeState.element);
      send("move-change", {
        selector: resizeState.selector,
        position: resizeState.element.style.position || getComputedStyle(resizeState.element).position,
        left: left + "px",
        top: top + "px",
        snappedX: snapX,
        snappedY: snapY
      });
      event.preventDefault();
      return;
    }
    var width = resizeState.startWidth;
    var height = resizeState.startHeight;
    if (resizeState.direction === "right" || resizeState.direction === "corner") {
      width = Math.max(8, Math.min(4096, resizeState.startWidth + event.clientX - resizeState.startX));
    }
    if (resizeState.direction === "bottom" || resizeState.direction === "corner") {
      height = Math.max(8, Math.min(4096, resizeState.startHeight + event.clientY - resizeState.startY));
    }
    width = Math.round(width);
    height = Math.round(height);
    suppressMutationsUntil = Date.now() + 350;
    resizeState.element.style.boxSizing = "border-box";
    if (resizeState.direction === "right" || resizeState.direction === "corner") {
      resizeState.element.style.width = width + "px";
    }
    if (resizeState.direction === "bottom" || resizeState.direction === "corner") {
      resizeState.element.style.height = height + "px";
    }
    positionOverlay(resizeState.element);
    send("resize-change", {
      selector: resizeState.selector,
      width: width + "px",
      height: height + "px",
      boxSizing: "border-box"
    });
    event.preventDefault();
  }

  function resizeEnd(event) {
    if (!resizeState) return;
    var completed = resizeState;
    resizeState = null;
    if (guideX) guideX.style.display = "none";
    if (guideY) guideY.style.display = "none";
    send(completed.direction === "move" ? "move-complete" : "resize-complete", {
      selector: completed.selector,
      width: completed.element.style.width,
      height: completed.element.style.height,
      position: completed.element.style.position,
      left: completed.element.style.left,
      top: completed.element.style.top,
      boxSizing: "border-box"
    });
    event.preventDefault();
  }

  document.addEventListener("pointermove", resizeMove, true);
  document.addEventListener("pointerup", resizeEnd, true);

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (character) {
      return "\\" + character;
    });
  }

  function selectorFor(element) {
    if (element.id) return "#" + cssEscape(element.id);
    var testId = element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && parts.length < 7) {
      var tag = current.tagName.toLowerCase();
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (candidate) {
          return candidate.tagName === current.tagName;
        });
        if (siblings.length > 1) tag += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(tag);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(" > ");
  }

  function sourcePathFor(element) {
    var explicit = element.getAttribute("data-glimmer-source");
    if (explicit) return explicit.slice(0, 4096);
    var vue = element.__vueParentComponent;
    if (vue && vue.type && typeof vue.type.__file === "string") return vue.type.__file.slice(0, 4096);
    var svelte = element.__svelte_meta;
    var svelteLocation = svelte && svelte.loc;
    if (svelteLocation && typeof svelteLocation.file === "string") {
      var svelteSource = svelteLocation.file;
      if (typeof svelteLocation.line === "number") svelteSource += ":" + svelteLocation.line;
      if (typeof svelteLocation.column === "number") svelteSource += ":" + svelteLocation.column;
      return svelteSource.slice(0, 4096);
    }
    var keys = Object.keys(element);
    for (var index = 0; index < keys.length; index += 1) {
      if (keys[index].indexOf("__reactFiber$") !== 0) continue;
      var fiber = element[keys[index]];
      var depth = 0;
      while (fiber && depth < 30) {
        var source = fiber._debugSource;
        if (source && typeof source.fileName === "string") {
          return (
            source.fileName +
            (source.lineNumber ? ":" + source.lineNumber : "") +
            (source.columnNumber ? ":" + source.columnNumber : "")
          ).slice(0, 4096);
        }
        fiber = fiber.return;
        depth += 1;
      }
    }
    return null;
  }

  function componentMetadataFor(element) {
    var vue = element.__vueParentComponent;
    if (vue && vue.type) {
      return {
        framework: "vue",
        componentName: String(vue.type.name || vue.type.__name || "Vue component").slice(0, 200)
      };
    }
    var keys = Object.keys(element);
    for (var index = 0; index < keys.length; index += 1) {
      if (keys[index].indexOf("__reactFiber$") !== 0) continue;
      var fiber = element[keys[index]];
      var depth = 0;
      while (fiber && depth < 30) {
        var type = fiber.type;
        var name = type && (type.displayName || type.name);
        if (typeof name === "string" && name && name !== "Fragment") {
          return { framework: "react", componentName: name.slice(0, 200) };
        }
        fiber = fiber.return;
        depth += 1;
      }
      return { framework: "react" };
    }
    if (
      element.__svelte_meta ||
      element.hasAttribute("data-svelte-h") ||
      document.querySelector("style[data-svelte]")
    ) {
      var svelteName = element.getAttribute("data-glimmer-component");
      return {
        framework: "svelte",
        componentName: svelteName ? svelteName.slice(0, 200) : undefined
      };
    }
    return { framework: "html" };
  }

  function breadcrumbsFor(element) {
    var result = [];
    var current = element;
    while (current && current.nodeType === 1 && result.length < 8) {
      var tagName = current.tagName.toLowerCase();
      var labelValue =
        current.getAttribute("aria-label") ||
        current.getAttribute("data-testid") ||
        current.id ||
        tagName;
      result.unshift({
        tagName: tagName,
        selector: selectorFor(current),
        label: String(labelValue).slice(0, 120)
      });
      if (current === document.body) break;
      current = current.parentElement;
    }
    return result;
  }

  var voidElements = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
  var hiddenStructureTags = ["script", "style", "link", "meta", "noscript", "template"];

  function structureLabelFor(element) {
    var metadata = componentMetadataFor(element);
    return String(
      metadata.componentName ||
      element.getAttribute("aria-label") ||
      element.getAttribute("data-testid") ||
      element.id ||
      element.tagName.toLowerCase()
    ).slice(0, 120);
  }

  function structureNodeFor(element, depth, budget) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return null;
    }
    budget.remaining -= 1;
    budget.total += 1;
    var tagName = element.tagName.toLowerCase();
    var metadata = componentMetadataFor(element);
    var attributes = {};
    ["id", "class", "data-testid", "aria-label", "role", "src", "alt", "href", "name", "type"].forEach(
      function (name) {
        var value = element.getAttribute(name);
        if (value !== null) attributes[name] = value.slice(0, 500);
      }
    );
    var children = [];
    if (depth < 12) {
      Array.prototype.forEach.call(element.children, function (child) {
        if (
          child.getAttribute("data-glimmer-overlay") === "true" ||
          hiddenStructureTags.indexOf(child.tagName.toLowerCase()) !== -1
        ) return;
        var node = structureNodeFor(child, depth + 1, budget);
        if (node) children.push(node);
      });
    } else if (element.children.length) {
      budget.truncated = true;
    }
    var computed = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return {
      selector: selectorFor(element),
      tagName: tagName,
      label: structureLabelFor(element),
      text: ownText(element).slice(0, 500),
      attributes: attributes,
      sourcePathHint: sourcePathFor(element) || undefined,
      framework: metadata.framework,
      componentName: metadata.componentName,
      canHaveChildren: voidElements.indexOf(tagName) === -1,
      hidden: computed.display === "none" || computed.visibility === "hidden" || rect.width === 0 || rect.height === 0,
      children: children
    };
  }

  function structureSnapshot() {
    var budget = { remaining: 500, total: 0, truncated: false };
    var roots = [];
    if (document.body) {
      var body = structureNodeFor(document.body, 0, budget);
      if (body) roots.push(body);
    }
    return { roots: roots, total: budget.total, truncated: budget.truncated };
  }

  function sendStructure() {
    send("structure", structureSnapshot());
  }

  function collectRules(ruleList, element, result, seen) {
    if (!ruleList || result.length >= 50) return;
    for (var index = 0; index < ruleList.length && result.length < 50; index += 1) {
      var rule = ruleList[index];
      if (rule.selectorText && rule.style) {
        try {
          if (element.matches(rule.selectorText)) collectStyleTokens(rule.style, element, result, seen);
        } catch (_error) {
          // An unsupported selector cannot bind to the selected element.
        }
        continue;
      }
      if (rule.cssRules && rule.cssRules.length) collectRules(rule.cssRules, element, result, seen);
    }
  }

  function collectStyleTokens(style, element, result, seen) {
    for (var index = 0; index < style.length && result.length < 50; index += 1) {
      var property = style[index];
      var declaration = style.getPropertyValue(property);
      var matches = declaration.match(/var\((--[A-Za-z0-9_-]+)/g) || [];
      for (var matchIndex = 0; matchIndex < matches.length && result.length < 50; matchIndex += 1) {
        var name = matches[matchIndex].slice(4);
        var key = name + "\u0000" + property;
        if (seen.has(key)) continue;
        var value = getComputedStyle(element).getPropertyValue(name).trim();
        if (!value) value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!value || value.length > 200) continue;
        seen.add(key);
        result.push({ name: name, value: value, property: property });
      }
    }
  }

  function tokensFor(element) {
    var result = [];
    var seen = new Set();
    collectStyleTokens(element.style, element, result, seen);
    for (var index = 0; index < document.styleSheets.length && result.length < 50; index += 1) {
      try {
        collectRules(document.styleSheets[index].cssRules, element, result, seen);
      } catch (_error) {
        // Cross-origin stylesheets deliberately remain opaque.
      }
    }
    return result;
  }

  function ownText(element) {
    var value = "";
    for (var index = 0; index < element.childNodes.length; index += 1) {
      var node = element.childNodes[index];
      if (node.nodeType === Node.TEXT_NODE) value += node.textContent || "";
    }
    value = value.trim();
    if (!value) value = (element.innerText || "").trim();
    return value.slice(0, 2000);
  }

  function specificityFor(selector) {
    var ids = (selector.match(/#[A-Za-z0-9_-]+/g) || []).length;
    var classes = (selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:(?!:)[A-Za-z0-9_-]+/g) || []).length;
    var elements = (selector.match(/(^|[\s>+~,(])(?:[A-Za-z][A-Za-z0-9-]*|::[A-Za-z0-9_-]+)/g) || []).length;
    return ids + "," + classes + "," + elements;
  }

  function sourceForRule(rule) {
    var sheet = rule.parentStyleSheet;
    if (!sheet || !sheet.href) return "<style>";
    try {
      var parsed = new URL(sheet.href, location.href);
      return parsed.origin === location.origin ? parsed.pathname.slice(0, 500) : "external stylesheet";
    } catch (_error) {
      return "stylesheet";
    }
  }

  function declarationsForStyle(style) {
    var declarations = [];
    for (var index = 0; index < style.length && declarations.length < 80; index += 1) {
      var property = style[index];
      declarations.push({
        property: property.slice(0, 100),
        value: style.getPropertyValue(property).trim().slice(0, 500),
        important: style.getPropertyPriority(property) === "important"
      });
    }
    return declarations;
  }

  function collectStyleSources(ruleList, element, result) {
    if (!ruleList || result.length >= 28) return;
    for (var index = 0; index < ruleList.length && result.length < 28; index += 1) {
      var rule = ruleList[index];
      if (rule.selectorText && rule.style) {
        try {
          if (element.matches(rule.selectorText)) {
            result.push({
              selector: rule.selectorText.slice(0, 1000),
              source: sourceForRule(rule),
              specificity: specificityFor(rule.selectorText),
              inherited: false,
              declarations: declarationsForStyle(rule.style)
            });
          }
        } catch (_error) {
          // Unsupported selectors are ignored without weakening the message boundary.
        }
      } else if (rule.cssRules && rule.cssRules.length) {
        collectStyleSources(rule.cssRules, element, result);
      }
    }
  }

  function styleSourcesFor(element) {
    var result = [];
    for (var index = 0; index < document.styleSheets.length && result.length < 28; index += 1) {
      try {
        collectStyleSources(document.styleSheets[index].cssRules, element, result);
      } catch (_error) {
        // Cross-origin stylesheets remain intentionally opaque.
      }
    }
    if (element.style && element.style.length) {
      result.push({
        selector: "element.style",
        source: "inline",
        specificity: "1,0,0,0",
        inherited: false,
        declarations: declarationsForStyle(element.style)
      });
    }
    var parent = element.parentElement;
    if (parent && result.length < 30) {
      var parentStyle = getComputedStyle(parent);
      var inherited = ["color", "font-family", "font-size", "font-weight", "line-height"]
        .map(function (property) {
          return { property: property, value: parentStyle.getPropertyValue(property).trim().slice(0, 500), important: false };
        })
        .filter(function (entry) { return entry.value; });
      if (inherited.length) {
        result.unshift({
          selector: selectorFor(parent),
          source: "inherited from parent",
          specificity: "inherited",
          inherited: true,
          declarations: inherited
        });
      }
    }
    return result;
  }

  function describe(element) {
    var computed = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    var attributes = {};
    ["id", "class", "data-testid", "aria-label", "role", "src", "alt", "href", "name", "type"].forEach(
      function (name) {
        var value = element.getAttribute(name);
        if (value !== null) attributes[name] = value.slice(0, 500);
      }
    );
    var sourcePathHint = sourcePathFor(element);
    var metadata = componentMetadataFor(element);
    var selector = selectorFor(element);
    var stableAttribute =
      element.getAttribute("data-testid") || element.getAttribute("data-glimmer-id") || element.id;
    return {
      selector: selector,
      tagName: element.tagName.toLowerCase(),
      text: ownText(element),
      attributes: attributes,
      styles: {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        padding: computed.padding,
        margin: computed.margin,
        gap: computed.gap,
        borderColor: computed.borderColor,
        borderWidth: computed.borderWidth,
        borderRadius: computed.borderRadius,
        opacity: computed.opacity,
        display: computed.display,
        flexDirection: computed.flexDirection,
        flexWrap: computed.flexWrap,
        alignItems: computed.alignItems,
        alignContent: computed.alignContent,
        justifyContent: computed.justifyContent,
        width: computed.width,
        height: computed.height,
        minWidth: computed.minWidth,
        maxWidth: computed.maxWidth,
        minHeight: computed.minHeight,
        maxHeight: computed.maxHeight,
        position: computed.position,
        top: computed.top,
        right: computed.right,
        bottom: computed.bottom,
        left: computed.left,
        zIndex: computed.zIndex,
        gridTemplateColumns: computed.gridTemplateColumns,
        gridTemplateRows: computed.gridTemplateRows,
        gridAutoFlow: computed.gridAutoFlow,
        gridColumn: computed.gridColumn,
        gridRow: computed.gridRow,
        order: computed.order,
        flex: computed.flex,
        boxSizing: computed.boxSizing
      },
      rect: {
        x: Math.max(0, Math.min(window.innerWidth, rect.x)),
        y: Math.max(0, Math.min(window.innerHeight, rect.y)),
        width: Math.max(0, Math.min(window.innerWidth, rect.width)),
        height: Math.max(0, Math.min(window.innerHeight, rect.height)),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      },
      tokens: tokensFor(element),
      sourcePathHint: sourcePathHint || undefined,
      framework: metadata.framework,
      componentName: metadata.componentName,
      stableId: String(stableAttribute || metadata.componentName || selector).slice(0, 500),
      breadcrumbs: breadcrumbsFor(element),
      styleSources: styleSourcesFor(element)
    };
  }

  function onMouseOver(event) {
    if (!selecting || !(event.target instanceof Element) || event.target === overlay) return;
    hovered = event.target;
    positionOverlay(hovered);
  }

  function onClick(event) {
    if (!selecting || !(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var additive = event.shiftKey === true;
    selecting = additive;
    hovered = event.target;
    selectedElement = event.target;
    positionOverlay(hovered);
    send("selected", { element: describe(hovered), additive: additive });
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || !selecting) return;
    selecting = false;
    hideOverlay();
    send("selection-cancelled");
  }

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", function () {
    if (hovered) positionOverlay(hovered);
    positionSecondaryOverlays();
  }, true);
  window.addEventListener("resize", function () {
    if (hovered) positionOverlay(hovered);
    positionSecondaryOverlays();
  });

  function validColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
  }

  function boundedNumber(value, minimum, maximum) {
    return typeof value === "number" && isFinite(value) && value >= minimum && value <= maximum;
  }

  function validImageSource(value) {
    if (typeof value !== "string" || !value || value.length > 200000) return false;
    if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,/i.test(value)) return true;
    if (value.length > 2048 || value.indexOf("//") === 0 || /^javascript:/i.test(value)) return false;
    try {
      var parsed = new URL(value, location.href);
      return parsed.origin === location.origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
    } catch (_error) {
      return false;
    }
  }

  function rememberOriginal(selector, element) {
    if (originals.has(selector)) return;
    originals.set(selector, {
      text: element.textContent,
      textApplied: false,
      style: element.getAttribute("style"),
      src: element.getAttribute("src")
    });
  }

  function validLayoutValue(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      !/[{};\u0000-\u001f]/.test(value) &&
      value.indexOf("/*") === -1 &&
      value.indexOf("*/") === -1 &&
      !/(?:url|expression)\s*\(/i.test(value) &&
      !/@import/i.test(value)
    );
  }

  function applyLayoutValue(element, patch, key, property) {
    if (validLayoutValue(patch[key])) element.style.setProperty(property, patch[key]);
  }

  function applyPreview(selector, patch) {
    var element;
    suppressMutationsUntil = Date.now() + 350;
    try {
      element = document.querySelector(selector);
    } catch (_error) {
      return send("preview-error", { error: "Selected element is no longer available." });
    }
    if (!element) return send("preview-error", { error: "Selected element is no longer available." });
    rememberOriginal(selector, element);
    if (Object.prototype.hasOwnProperty.call(patch, "text") && typeof patch.text === "string" && patch.text.length <= 5000) {
      if (element.children.length === 0) {
        element.textContent = patch.text;
        originals.get(selector).textApplied = true;
      } else {
        send("preview-error", { error: "Text preview is limited to elements without nested markup." });
      }
    }
    if (validColor(patch.textColor)) element.style.color = patch.textColor;
    if (validColor(patch.backgroundColor)) element.style.backgroundColor = patch.backgroundColor;
    if (validColor(patch.borderColor)) element.style.borderColor = patch.borderColor;
    if (typeof patch.fontFamily === "string" && patch.fontFamily.length <= 200 && !/[{};]/.test(patch.fontFamily)) {
      element.style.fontFamily = patch.fontFamily;
    }
    if (boundedNumber(patch.fontSizePx, 8, 240)) element.style.fontSize = patch.fontSizePx + "px";
    if (boundedNumber(patch.fontWeight, 100, 900)) element.style.fontWeight = String(patch.fontWeight);
    if (boundedNumber(patch.lineHeight, 0.5, 4)) element.style.lineHeight = String(patch.lineHeight);
    if (boundedNumber(patch.paddingPx, 0, 512)) element.style.padding = patch.paddingPx + "px";
    if (boundedNumber(patch.marginPx, -512, 512)) element.style.margin = patch.marginPx + "px";
    if (boundedNumber(patch.gapPx, 0, 512)) element.style.gap = patch.gapPx + "px";
    if (boundedNumber(patch.borderWidthPx, 0, 64)) element.style.borderWidth = patch.borderWidthPx + "px";
    if (boundedNumber(patch.borderRadiusPx, 0, 2000)) element.style.borderRadius = patch.borderRadiusPx + "px";
    if (boundedNumber(patch.opacity, 0, 1)) element.style.opacity = String(patch.opacity);
    if (patch.direction === "row" || patch.direction === "column") element.style.flexDirection = patch.direction;
    if (["start", "center", "end", "space-between"].indexOf(patch.align) !== -1) {
      element.style.justifyContent = patch.align === "start" ? "flex-start" : patch.align === "end" ? "flex-end" : patch.align;
    }
    applyLayoutValue(element, patch, "display", "display");
    applyLayoutValue(element, patch, "flexWrap", "flex-wrap");
    applyLayoutValue(element, patch, "alignItemsValue", "align-items");
    applyLayoutValue(element, patch, "alignContent", "align-content");
    applyLayoutValue(element, patch, "width", "width");
    applyLayoutValue(element, patch, "height", "height");
    applyLayoutValue(element, patch, "minWidth", "min-width");
    applyLayoutValue(element, patch, "maxWidth", "max-width");
    applyLayoutValue(element, patch, "minHeight", "min-height");
    applyLayoutValue(element, patch, "maxHeight", "max-height");
    applyLayoutValue(element, patch, "position", "position");
    applyLayoutValue(element, patch, "top", "top");
    applyLayoutValue(element, patch, "right", "right");
    applyLayoutValue(element, patch, "bottom", "bottom");
    applyLayoutValue(element, patch, "left", "left");
    applyLayoutValue(element, patch, "zIndex", "z-index");
    applyLayoutValue(element, patch, "gridTemplateColumns", "grid-template-columns");
    applyLayoutValue(element, patch, "gridTemplateRows", "grid-template-rows");
    applyLayoutValue(element, patch, "gridAutoFlow", "grid-auto-flow");
    applyLayoutValue(element, patch, "gridColumn", "grid-column");
    applyLayoutValue(element, patch, "gridRow", "grid-row");
    applyLayoutValue(element, patch, "order", "order");
    applyLayoutValue(element, patch, "flex", "flex");
    applyLayoutValue(element, patch, "boxSizing", "box-sizing");
    if (element.tagName === "IMG" && validImageSource(patch.imageSource)) {
      element.setAttribute("src", patch.imageSource);
    }
    positionOverlay(element);
    send("preview-applied");
  }

  function resetPreview(selector) {
    var original = originals.get(selector);
    suppressMutationsUntil = Date.now() + 350;
    var element;
    try {
      element = document.querySelector(selector);
    } catch (_error) {
      element = null;
    }
    if (!original || !element) return;
    if (original.textApplied) element.textContent = original.text;
    if (original.style === null) element.removeAttribute("style");
    else element.setAttribute("style", original.style);
    if (original.src === null) element.removeAttribute("src");
    else element.setAttribute("src", original.src);
    originals.delete(selector);
    positionOverlay(element);
  }

  function resetStructurePreview() {
    if (!structurePreview) return;
    suppressMutationsUntil = Date.now() + 350;
    if (structurePreview.inserted) {
      if (structurePreview.inserted.parentNode) structurePreview.inserted.parentNode.removeChild(structurePreview.inserted);
    } else if (structurePreview.moving && structurePreview.parent) {
      structurePreview.parent.insertBefore(structurePreview.moving, structurePreview.nextSibling || null);
    }
    structurePreview = null;
    sendStructure();
  }

  function previewElementFor(preset, text) {
    var element;
    if (preset === "section") {
      element = document.createElement("section");
      var heading = document.createElement("h2");
      heading.textContent = text || "New section";
      element.appendChild(heading);
    } else if (preset === "heading") {
      element = document.createElement("h2");
      element.textContent = text || "New heading";
    } else if (preset === "paragraph") {
      element = document.createElement("p");
      element.textContent = text || "New paragraph";
    } else if (preset === "button") {
      element = document.createElement("button");
      element.type = "button";
      element.textContent = text || "Button";
    } else if (preset === "divider") {
      element = document.createElement("hr");
    } else {
      return null;
    }
    element.setAttribute("data-glimmer-structure-preview", "true");
    return element;
  }

  function previewStructure(message) {
    resetStructurePreview();
    suppressMutationsUntil = Date.now() + 350;
    var moving;
    var target;
    try {
      moving = message.movingSelector ? document.querySelector(message.movingSelector) : null;
      target = document.querySelector(message.targetSelector);
    } catch (_error) {
      return send("preview-error", { error: "Structure target is no longer available." });
    }
    if (!target || target === document.body && message.placement !== "inside-start" && message.placement !== "inside-end") {
      return send("preview-error", { error: "Structure target is no longer available." });
    }
    if (message.kind === "insert") {
      var inserted = previewElementFor(message.preset, typeof message.text === "string" ? message.text.slice(0, 500) : "");
      if (!inserted) return send("preview-error", { error: "Unsupported structure preset." });
      if ((message.placement === "inside-start" || message.placement === "inside-end") && voidElements.indexOf(target.tagName.toLowerCase()) !== -1) {
        return send("preview-error", { error: "This element cannot contain children." });
      }
      if (message.placement === "before") target.parentNode.insertBefore(inserted, target);
      else if (message.placement === "after") target.parentNode.insertBefore(inserted, target.nextSibling);
      else if (message.placement === "inside-start") target.insertBefore(inserted, target.firstChild);
      else target.appendChild(inserted);
      structurePreview = { inserted: inserted };
    } else {
      if (!moving || moving === document.body || moving === target || moving.contains(target)) {
        return send("preview-error", { error: "That structure move is not safe." });
      }
      if ((message.placement === "inside-start" || message.placement === "inside-end") && voidElements.indexOf(target.tagName.toLowerCase()) !== -1) {
        return send("preview-error", { error: "This element cannot contain children." });
      }
      structurePreview = {
        moving: moving,
        parent: moving.parentNode,
        nextSibling: moving.nextSibling
      };
      if (message.placement === "before") target.parentNode.insertBefore(moving, target);
      else if (message.placement === "after") target.parentNode.insertBefore(moving, target.nextSibling);
      else if (message.placement === "inside-start") target.insertBefore(moving, target.firstChild);
      else target.appendChild(moving);
    }
    sendStructure();
    send("structure-preview-applied");
  }

  function resetResponsivePreview() {
    if (responsivePreview && responsivePreview.parentNode) responsivePreview.parentNode.removeChild(responsivePreview);
    responsivePreview = null;
  }

  function previewResponsive(message) {
    resetResponsivePreview();
    var breakpoints = {
      mobile: "(max-width: 479px)",
      tablet: "(min-width: 480px) and (max-width: 991px)",
      desktop: "(min-width: 992px)"
    };
    var properties = ["color", "background-color", "font-size", "font-weight", "line-height", "padding", "margin", "gap", "border-width", "border-radius", "opacity", "flex-direction", "align-items", "justify-content"];
    if (
      typeof message.selector !== "string" ||
      message.selector.length > 1000 ||
      /[{};]/.test(message.selector) ||
      !breakpoints[message.breakpoint] ||
      properties.indexOf(message.property) === -1 ||
      typeof message.value !== "string" ||
      !message.value ||
      message.value.length > 200 ||
      /[{};]/.test(message.value)
    ) return send("preview-error", { error: "Responsive preview value is invalid." });
    var style = document.createElement("style");
    style.setAttribute("data-glimmer-responsive-preview", "true");
    style.textContent = "@media " + breakpoints[message.breakpoint] + " { " + message.selector + " { " + message.property + ": " + message.value + "; } }";
    document.head.appendChild(style);
    responsivePreview = style;
    suppressMutationsUntil = Date.now() + 350;
    send("responsive-preview-applied");
  }

  function resetStyleRulePreview() {
    if (styleRulePreview && styleRulePreview.parentNode) {
      styleRulePreview.parentNode.removeChild(styleRulePreview);
    }
    styleRulePreview = null;
  }

  function previewStyleRule(message) {
    resetStyleRulePreview();
    var properties = ["display", "width", "height", "min-width", "max-width", "min-height", "max-height", "position", "top", "right", "bottom", "left", "z-index", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "grid-column", "grid-row", "flex-direction", "flex-wrap", "align-items", "align-content", "justify-content", "order", "flex", "gap", "padding", "margin", "box-sizing"];
    if (
      typeof message.selector !== "string" ||
      !message.selector ||
      message.selector.length > 1000 ||
      /[{};]/.test(message.selector) ||
      !message.declarations ||
      typeof message.declarations !== "object" ||
      Array.isArray(message.declarations)
    ) return send("preview-error", { error: "Component style preview is invalid." });
    var entries = Object.keys(message.declarations);
    if (!entries.length || entries.length > 30) {
      return send("preview-error", { error: "Component style preview is empty or too large." });
    }
    var css = [];
    for (var index = 0; index < entries.length; index += 1) {
      var property = entries[index];
      var value = message.declarations[property];
      if (properties.indexOf(property) === -1 || !validLayoutValue(value)) {
        return send("preview-error", { error: "Component style preview contains an unsafe value." });
      }
      css.push(property + ": " + value + ";");
    }
    var style = document.createElement("style");
    style.setAttribute("data-glimmer-style-preview", "true");
    style.textContent = message.selector + " { " + css.join(" ") + " }";
    document.head.appendChild(style);
    styleRulePreview = style;
    suppressMutationsUntil = Date.now() + 350;
    send("style-rule-preview-applied");
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.namespace !== namespace || event.source !== window.parent) return;
    if (message.type === "init") {
      if (!allowedParent(event.origin) || typeof message.channel !== "string" || message.channel.length > 100) return;
      channel = message.channel;
      parentWindow = event.source;
      parentOrigin = event.origin;
      send("ready", { version: 2, url: location.href });
      return sendStructure();
    }
    if (!channel || message.channel !== channel || event.origin !== parentOrigin || event.source !== parentWindow) return;
    if (message.type === "select") {
      selecting = true;
      send("selection-enabled");
      return;
    }
    if (message.type === "cancel-select") {
      selecting = false;
      hideOverlay();
      return;
    }
    if (message.type === "preview" && typeof message.selector === "string" && message.patch && typeof message.patch === "object") {
      applyPreview(message.selector, message.patch);
      return;
    }
    if (message.type === "reset-preview" && typeof message.selector === "string") {
      resetPreview(message.selector);
      return;
    }
    if (message.type === "describe-selector" && typeof message.selector === "string") {
      var describedElement;
      try {
        describedElement = document.querySelector(message.selector);
      } catch (_error) {
        describedElement = null;
      }
      if (describedElement) {
        hovered = describedElement;
        selectedElement = describedElement;
        positionOverlay(describedElement);
        send("selected", { element: describe(describedElement), reselected: true });
      } else {
        send("selection-stale", { selector: message.selector });
      }
      return;
    }
    if (message.type === "describe-many" && Array.isArray(message.selectors)) {
      var describedElements = [];
      message.selectors.slice(0, 50).forEach(function (selector) {
        if (typeof selector !== "string" || selector.length > 1000) return;
        try {
          var described = document.querySelector(selector);
          if (described) describedElements.push(describe(described));
        } catch (_error) {
          // Invalid or stale selectors are omitted from the restored selection.
        }
      });
      send("selection-many", { elements: describedElements });
      return;
    }
    if (message.type === "request-structure") {
      sendStructure();
      return;
    }
    if (message.type === "highlight-selector" && typeof message.selector === "string") {
      try {
        var highlighted = document.querySelector(message.selector);
        if (highlighted) positionOverlay(highlighted);
      } catch (_error) {
        // Invalid selectors never leave the preview.
      }
      return;
    }
    if (message.type === "clear-highlight") {
      if (selectedElement) positionOverlay(selectedElement);
      else hideOverlay();
      return;
    }
    if (message.type === "highlight-many") {
      highlightMany(message.selectors);
      return;
    }
    if (message.type === "set-preview-visibility" && typeof message.selector === "string") {
      var visibilityElement;
      try {
        visibilityElement = document.querySelector(message.selector);
      } catch (_error) {
        visibilityElement = null;
      }
      if (!visibilityElement) return send("preview-error", { error: "Element is no longer available." });
      if (message.hidden === true) {
        if (!visibilityOriginals.has(message.selector)) {
          visibilityOriginals.set(message.selector, visibilityElement.getAttribute("style"));
        }
        visibilityElement.style.visibility = "hidden";
      } else if (visibilityOriginals.has(message.selector)) {
        var originalVisibilityStyle = visibilityOriginals.get(message.selector);
        if (originalVisibilityStyle === null) visibilityElement.removeAttribute("style");
        else visibilityElement.setAttribute("style", originalVisibilityStyle);
        visibilityOriginals.delete(message.selector);
      }
      suppressMutationsUntil = Date.now() + 350;
      sendStructure();
      return;
    }
    if (message.type === "preview-structure" && message.operation && typeof message.operation === "object") {
      previewStructure(message.operation);
      return;
    }
    if (message.type === "reset-structure-preview") {
      resetStructurePreview();
      return;
    }
    if (message.type === "preview-responsive" && message.override && typeof message.override === "object") {
      previewResponsive(message.override);
      return;
    }
    if (message.type === "reset-responsive-preview") {
      resetResponsivePreview();
      return;
    }
    if (message.type === "enable-resize") {
      resizeEnabled = message.enabled === true;
      if (!resizeEnabled) resizeState = null;
      if (selectedElement) positionOverlay(selectedElement);
      send("resize-mode", { enabled: resizeEnabled });
      return;
    }
    if (message.type === "preview-style-rule" && message.rule && typeof message.rule === "object") {
      previewStyleRule(message.rule);
      return;
    }
    if (message.type === "reset-style-rule-preview") {
      resetStyleRulePreview();
      return;
    }
  });

  var mutationTimer = null;
  var observer = new MutationObserver(function (records) {
    if (Date.now() < suppressMutationsUntil) return;
    var relevant = records.some(function (record) {
      var target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target && target !== overlay && (!overlay || !overlay.contains(target));
    });
    if (!relevant || !channel) return;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function () {
      mutationTimer = null;
      send("dom-updated");
    }, 160);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true
  });
})();
`;
