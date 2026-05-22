import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS((exports) => {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});

// ../../node_modules/yaml/dist/visit.js
var require_visit = __commonJS((exports) => {
  var identity = require_identity();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});

// ../../node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});

// ../../node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});

// ../../node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS((exports) => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            val.delete(k);
          else if (v1 !== v0)
            val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            delete val[k];
          else if (v1 !== v0)
            val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});

// ../../node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS((exports) => {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res2) => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});

// ../../node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS((exports) => {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});

// ../../node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS((exports) => {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});

// ../../node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});

// ../../node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node2 = new Scalar.Scalar(value);
        if (ref)
          ref.node = node2;
        return node2;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});

// ../../node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS((exports) => {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path, value) {
    let v = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k = path[i];
      if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});

// ../../node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS((exports) => {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});

// ../../node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS((exports) => {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j])
              return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0;i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});

// ../../node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});

// ../../node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS((exports) => {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});

// ../../node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});

// ../../node_modules/yaml/dist/log.js
var require_log = __commonJS((exports) => {
  var node_process = __require("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    value = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (identity.isSeq(value))
      for (const it of value.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(value))
      for (const it of value)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, value);
  }
  function mergeValue(ctx, map, value) {
    const source = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});

// ../../node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS((exports) => {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});

// ../../node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});

// ../../node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
      if (comment2)
        str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2)
        chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      if (i < items.length - 1)
        str += ",";
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      if (!reqNewline && (lines.length > linesAtValue || str.includes(`
`)))
        reqNewline = true;
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});

// ../../node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS((exports) => {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});

// ../../node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map2, onError) {
      if (!identity.isMap(map2))
        onError("Expected a mapping for this tag");
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});

// ../../node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});

// ../../node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2))
        onError("Expected a sequence for this tag");
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});

// ../../node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS((exports) => {
  var stringifyString = require_stringifyString();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});

// ../../node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});

// ../../node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});

// ../../node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS((exports) => {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});

// ../../node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// ../../node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// ../../node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});

// ../../node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS((exports) => {
  var node_buffer = __require("buffer");
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS((exports) => {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx)
        return super.toJSON(_);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this;
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === "-" ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30)
          d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});

// ../../node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj))
        tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});

// ../../node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS((exports) => {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});

// ../../node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});

// ../../node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS((exports) => {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});

// ../../node_modules/yaml/dist/errors.js
var require_errors = __commonJS((exports) => {
  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "…" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "…";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `…
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});

// ../../node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS((exports) => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});

// ../../node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS((exports) => {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});

// ../../node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS((exports) => {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});

// ../../node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS((exports) => {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});

// ../../node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS((exports) => {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});

// ../../node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS((exports) => {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});

// ../../node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS((exports) => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep + cb;
            sep = "";
            break;
          }
          case "newline":
            if (comment)
              sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});

// ../../node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd)
      cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce && ce.source.length !== 1)
        ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});

// ../../node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});

// ../../node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end2 = start + header.length;
      if (scalar.source)
        end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep === " ")
          sep = `
`;
        else if (!prevMoreIndented && sep === `
`)
          sep = `

`;
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep === `
`)
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});

// ../../node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
      line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match = first.exec(source);
    if (!match)
      return source;
    let res = match[1];
    let sep = " ";
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while (match = line.exec(source)) {
      if (match[1] === "") {
        if (sep === `
`)
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + match[1];
        sep = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = { x: 2, u: 4, U: 8 }[next];
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "",
    _: " ",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    if (isNaN(code)) {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
    return String.fromCodePoint(code);
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});

// ../../node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});

// ../../node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS((exports) => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});

// ../../node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        node = composeCollection.composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError);
        isSrcToken = false;
      }
    }
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment)
      alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});

// ../../node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS((exports) => {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment)
      doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});

// ../../node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS((exports) => {
  var node_process = __require("process");
  var directives = require_directives();
  var Document = require_Document();
  var errors = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        Array.prototype.push.apply(doc.errors, this.errors);
        Array.prototype.push.apply(doc.warnings, this.warnings);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});

// ../../node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS((exports) => {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body = source.substring(he + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body = source.substring(he + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});

// ../../node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS((exports) => {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep)
      for (const st of sep)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});

// ../../node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS((exports) => {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});

// ../../node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS((exports) => {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});

// ../../node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS((exports) => {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return yield* this.parseBlockStart();
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i2 = this.pos;ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === "\r")
            ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === " ")
            ch2 = this.buffer[--i2];
          if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
            nl = i2;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      switch (this.charAt(0)) {
        case "!":
          return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "&":
          return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "-":
        case "?":
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          }
        }
      }
      return 0;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});

// ../../node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS((exports) => {
  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});

// ../../node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS((exports) => {
  var node_process = __require("process");
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              Array.prototype.push.apply(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            Array.prototype.push.apply(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else
          sep = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});

// ../../node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS((exports) => {
  var composer = require_composer();
  var Document = require_Document();
  var errors = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});

// ../../node_modules/dotenv/package.json
var require_package = __commonJS((exports, module) => {
  module.exports = {
    name: "dotenv",
    version: "16.6.1",
    description: "Loads environment variables from .env file",
    main: "lib/main.js",
    types: "lib/main.d.ts",
    exports: {
      ".": {
        types: "./lib/main.d.ts",
        require: "./lib/main.js",
        default: "./lib/main.js"
      },
      "./config": "./config.js",
      "./config.js": "./config.js",
      "./lib/env-options": "./lib/env-options.js",
      "./lib/env-options.js": "./lib/env-options.js",
      "./lib/cli-options": "./lib/cli-options.js",
      "./lib/cli-options.js": "./lib/cli-options.js",
      "./package.json": "./package.json"
    },
    scripts: {
      "dts-check": "tsc --project tests/types/tsconfig.json",
      lint: "standard",
      pretest: "npm run lint && npm run dts-check",
      test: "tap run --allow-empty-coverage --disable-coverage --timeout=60000",
      "test:coverage": "tap run --show-full-coverage --timeout=60000 --coverage-report=text --coverage-report=lcov",
      prerelease: "npm test",
      release: "standard-version"
    },
    repository: {
      type: "git",
      url: "git://github.com/motdotla/dotenv.git"
    },
    homepage: "https://github.com/motdotla/dotenv#readme",
    funding: "https://dotenvx.com",
    keywords: [
      "dotenv",
      "env",
      ".env",
      "environment",
      "variables",
      "config",
      "settings"
    ],
    readmeFilename: "README.md",
    license: "BSD-2-Clause",
    devDependencies: {
      "@types/node": "^18.11.3",
      decache: "^4.6.2",
      sinon: "^14.0.1",
      standard: "^17.0.0",
      "standard-version": "^9.5.0",
      tap: "^19.2.0",
      typescript: "^4.8.4"
    },
    engines: {
      node: ">=12"
    },
    browser: {
      fs: false
    }
  };
});

// ../../node_modules/dotenv/lib/main.js
var require_main = __commonJS((exports, module) => {
  var fs = __require("fs");
  var path = __require("path");
  var os = __require("os");
  var crypto = __require("crypto");
  var packageJson = require_package();
  var version = packageJson.version;
  var LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  function parse(src) {
    const obj = {};
    let lines = src.toString();
    lines = lines.replace(/\r\n?/mg, `
`);
    let match;
    while ((match = LINE.exec(lines)) != null) {
      const key = match[1];
      let value = match[2] || "";
      value = value.trim();
      const maybeQuote = value[0];
      value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
      if (maybeQuote === '"') {
        value = value.replace(/\\n/g, `
`);
        value = value.replace(/\\r/g, "\r");
      }
      obj[key] = value;
    }
    return obj;
  }
  function _parseVault(options) {
    options = options || {};
    const vaultPath = _vaultPath(options);
    options.path = vaultPath;
    const result = DotenvModule.configDotenv(options);
    if (!result.parsed) {
      const err = new Error(`MISSING_DATA: Cannot parse ${vaultPath} for an unknown reason`);
      err.code = "MISSING_DATA";
      throw err;
    }
    const keys = _dotenvKey(options).split(",");
    const length = keys.length;
    let decrypted;
    for (let i = 0;i < length; i++) {
      try {
        const key = keys[i].trim();
        const attrs = _instructions(result, key);
        decrypted = DotenvModule.decrypt(attrs.ciphertext, attrs.key);
        break;
      } catch (error) {
        if (i + 1 >= length) {
          throw error;
        }
      }
    }
    return DotenvModule.parse(decrypted);
  }
  function _warn(message) {
    console.log(`[dotenv@${version}][WARN] ${message}`);
  }
  function _debug(message) {
    console.log(`[dotenv@${version}][DEBUG] ${message}`);
  }
  function _log(message) {
    console.log(`[dotenv@${version}] ${message}`);
  }
  function _dotenvKey(options) {
    if (options && options.DOTENV_KEY && options.DOTENV_KEY.length > 0) {
      return options.DOTENV_KEY;
    }
    if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
      return process.env.DOTENV_KEY;
    }
    return "";
  }
  function _instructions(result, dotenvKey) {
    let uri;
    try {
      uri = new URL(dotenvKey);
    } catch (error) {
      if (error.code === "ERR_INVALID_URL") {
        const err = new Error("INVALID_DOTENV_KEY: Wrong format. Must be in valid uri format like dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=development");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      throw error;
    }
    const key = uri.password;
    if (!key) {
      const err = new Error("INVALID_DOTENV_KEY: Missing key part");
      err.code = "INVALID_DOTENV_KEY";
      throw err;
    }
    const environment = uri.searchParams.get("environment");
    if (!environment) {
      const err = new Error("INVALID_DOTENV_KEY: Missing environment part");
      err.code = "INVALID_DOTENV_KEY";
      throw err;
    }
    const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`;
    const ciphertext = result.parsed[environmentKey];
    if (!ciphertext) {
      const err = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: Cannot locate environment ${environmentKey} in your .env.vault file.`);
      err.code = "NOT_FOUND_DOTENV_ENVIRONMENT";
      throw err;
    }
    return { ciphertext, key };
  }
  function _vaultPath(options) {
    let possibleVaultPath = null;
    if (options && options.path && options.path.length > 0) {
      if (Array.isArray(options.path)) {
        for (const filepath of options.path) {
          if (fs.existsSync(filepath)) {
            possibleVaultPath = filepath.endsWith(".vault") ? filepath : `${filepath}.vault`;
          }
        }
      } else {
        possibleVaultPath = options.path.endsWith(".vault") ? options.path : `${options.path}.vault`;
      }
    } else {
      possibleVaultPath = path.resolve(process.cwd(), ".env.vault");
    }
    if (fs.existsSync(possibleVaultPath)) {
      return possibleVaultPath;
    }
    return null;
  }
  function _resolveHome(envPath) {
    return envPath[0] === "~" ? path.join(os.homedir(), envPath.slice(1)) : envPath;
  }
  function _configVault(options) {
    const debug = Boolean(options && options.debug);
    const quiet = options && "quiet" in options ? options.quiet : true;
    if (debug || !quiet) {
      _log("Loading env from encrypted .env.vault");
    }
    const parsed = DotenvModule._parseVault(options);
    let processEnv = process.env;
    if (options && options.processEnv != null) {
      processEnv = options.processEnv;
    }
    DotenvModule.populate(processEnv, parsed, options);
    return { parsed };
  }
  function configDotenv(options) {
    const dotenvPath = path.resolve(process.cwd(), ".env");
    let encoding = "utf8";
    const debug = Boolean(options && options.debug);
    const quiet = options && "quiet" in options ? options.quiet : true;
    if (options && options.encoding) {
      encoding = options.encoding;
    } else {
      if (debug) {
        _debug("No encoding is specified. UTF-8 is used by default");
      }
    }
    let optionPaths = [dotenvPath];
    if (options && options.path) {
      if (!Array.isArray(options.path)) {
        optionPaths = [_resolveHome(options.path)];
      } else {
        optionPaths = [];
        for (const filepath of options.path) {
          optionPaths.push(_resolveHome(filepath));
        }
      }
    }
    let lastError;
    const parsedAll = {};
    for (const path2 of optionPaths) {
      try {
        const parsed = DotenvModule.parse(fs.readFileSync(path2, { encoding }));
        DotenvModule.populate(parsedAll, parsed, options);
      } catch (e) {
        if (debug) {
          _debug(`Failed to load ${path2} ${e.message}`);
        }
        lastError = e;
      }
    }
    let processEnv = process.env;
    if (options && options.processEnv != null) {
      processEnv = options.processEnv;
    }
    DotenvModule.populate(processEnv, parsedAll, options);
    if (debug || !quiet) {
      const keysCount = Object.keys(parsedAll).length;
      const shortPaths = [];
      for (const filePath of optionPaths) {
        try {
          const relative = path.relative(process.cwd(), filePath);
          shortPaths.push(relative);
        } catch (e) {
          if (debug) {
            _debug(`Failed to load ${filePath} ${e.message}`);
          }
          lastError = e;
        }
      }
      _log(`injecting env (${keysCount}) from ${shortPaths.join(",")}`);
    }
    if (lastError) {
      return { parsed: parsedAll, error: lastError };
    } else {
      return { parsed: parsedAll };
    }
  }
  function config(options) {
    if (_dotenvKey(options).length === 0) {
      return DotenvModule.configDotenv(options);
    }
    const vaultPath = _vaultPath(options);
    if (!vaultPath) {
      _warn(`You set DOTENV_KEY but you are missing a .env.vault file at ${vaultPath}. Did you forget to build it?`);
      return DotenvModule.configDotenv(options);
    }
    return DotenvModule._configVault(options);
  }
  function decrypt(encrypted, keyStr) {
    const key = Buffer.from(keyStr.slice(-64), "hex");
    let ciphertext = Buffer.from(encrypted, "base64");
    const nonce = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(-16);
    ciphertext = ciphertext.subarray(12, -16);
    try {
      const aesgcm = crypto.createDecipheriv("aes-256-gcm", key, nonce);
      aesgcm.setAuthTag(authTag);
      return `${aesgcm.update(ciphertext)}${aesgcm.final()}`;
    } catch (error) {
      const isRange = error instanceof RangeError;
      const invalidKeyLength = error.message === "Invalid key length";
      const decryptionFailed = error.message === "Unsupported state or unable to authenticate data";
      if (isRange || invalidKeyLength) {
        const err = new Error("INVALID_DOTENV_KEY: It must be 64 characters long (or more)");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      } else if (decryptionFailed) {
        const err = new Error("DECRYPTION_FAILED: Please check your DOTENV_KEY");
        err.code = "DECRYPTION_FAILED";
        throw err;
      } else {
        throw error;
      }
    }
  }
  function populate(processEnv, parsed, options = {}) {
    const debug = Boolean(options && options.debug);
    const override = Boolean(options && options.override);
    if (typeof parsed !== "object") {
      const err = new Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");
      err.code = "OBJECT_REQUIRED";
      throw err;
    }
    for (const key of Object.keys(parsed)) {
      if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
        if (override === true) {
          processEnv[key] = parsed[key];
        }
        if (debug) {
          if (override === true) {
            _debug(`"${key}" is already defined and WAS overwritten`);
          } else {
            _debug(`"${key}" is already defined and was NOT overwritten`);
          }
        }
      } else {
        processEnv[key] = parsed[key];
      }
    }
  }
  var DotenvModule = {
    configDotenv,
    _configVault,
    _parseVault,
    config,
    decrypt,
    parse,
    populate
  };
  exports.configDotenv = DotenvModule.configDotenv;
  exports._configVault = DotenvModule._configVault;
  exports._parseVault = DotenvModule._parseVault;
  exports.config = DotenvModule.config;
  exports.decrypt = DotenvModule.decrypt;
  exports.parse = DotenvModule.parse;
  exports.populate = DotenvModule.populate;
  module.exports = DotenvModule;
});

// ../../node_modules/tar/lib/high-level-opt.js
var require_high_level_opt = __commonJS((exports, module) => {
  var argmap = new Map([
    ["C", "cwd"],
    ["f", "file"],
    ["z", "gzip"],
    ["P", "preservePaths"],
    ["U", "unlink"],
    ["strip-components", "strip"],
    ["stripComponents", "strip"],
    ["keep-newer", "newer"],
    ["keepNewer", "newer"],
    ["keep-newer-files", "newer"],
    ["keepNewerFiles", "newer"],
    ["k", "keep"],
    ["keep-existing", "keep"],
    ["keepExisting", "keep"],
    ["m", "noMtime"],
    ["no-mtime", "noMtime"],
    ["p", "preserveOwner"],
    ["L", "follow"],
    ["h", "follow"]
  ]);
  module.exports = (opt) => opt ? Object.keys(opt).map((k) => [
    argmap.has(k) ? argmap.get(k) : k,
    opt[k]
  ]).reduce((set, kv) => (set[kv[0]] = kv[1], set), Object.create(null)) : {};
});

// ../../node_modules/tar/node_modules/minipass/index.js
var require_minipass = __commonJS((exports) => {
  var proc = typeof process === "object" && process ? process : {
    stdout: null,
    stderr: null
  };
  var EE = __require("events");
  var Stream = __require("stream");
  var stringdecoder = __require("string_decoder");
  var SD = stringdecoder.StringDecoder;
  var EOF = Symbol("EOF");
  var MAYBE_EMIT_END = Symbol("maybeEmitEnd");
  var EMITTED_END = Symbol("emittedEnd");
  var EMITTING_END = Symbol("emittingEnd");
  var EMITTED_ERROR = Symbol("emittedError");
  var CLOSED = Symbol("closed");
  var READ = Symbol("read");
  var FLUSH = Symbol("flush");
  var FLUSHCHUNK = Symbol("flushChunk");
  var ENCODING = Symbol("encoding");
  var DECODER = Symbol("decoder");
  var FLOWING = Symbol("flowing");
  var PAUSED = Symbol("paused");
  var RESUME = Symbol("resume");
  var BUFFER = Symbol("buffer");
  var PIPES = Symbol("pipes");
  var BUFFERLENGTH = Symbol("bufferLength");
  var BUFFERPUSH = Symbol("bufferPush");
  var BUFFERSHIFT = Symbol("bufferShift");
  var OBJECTMODE = Symbol("objectMode");
  var DESTROYED = Symbol("destroyed");
  var ERROR = Symbol("error");
  var EMITDATA = Symbol("emitData");
  var EMITEND = Symbol("emitEnd");
  var EMITEND2 = Symbol("emitEnd2");
  var ASYNC = Symbol("async");
  var ABORT = Symbol("abort");
  var ABORTED = Symbol("aborted");
  var SIGNAL = Symbol("signal");
  var defer = (fn) => Promise.resolve().then(fn);
  var doIter = global._MP_NO_ITERATOR_SYMBOLS_ !== "1";
  var ASYNCITERATOR = doIter && Symbol.asyncIterator || Symbol("asyncIterator not implemented");
  var ITERATOR = doIter && Symbol.iterator || Symbol("iterator not implemented");
  var isEndish = (ev) => ev === "end" || ev === "finish" || ev === "prefinish";
  var isArrayBuffer = (b) => b instanceof ArrayBuffer || typeof b === "object" && b.constructor && b.constructor.name === "ArrayBuffer" && b.byteLength >= 0;
  var isArrayBufferView = (b) => !Buffer.isBuffer(b) && ArrayBuffer.isView(b);

  class Pipe {
    constructor(src, dest, opts) {
      this.src = src;
      this.dest = dest;
      this.opts = opts;
      this.ondrain = () => src[RESUME]();
      dest.on("drain", this.ondrain);
    }
    unpipe() {
      this.dest.removeListener("drain", this.ondrain);
    }
    proxyErrors() {}
    end() {
      this.unpipe();
      if (this.opts.end)
        this.dest.end();
    }
  }

  class PipeProxyErrors extends Pipe {
    unpipe() {
      this.src.removeListener("error", this.proxyErrors);
      super.unpipe();
    }
    constructor(src, dest, opts) {
      super(src, dest, opts);
      this.proxyErrors = (er) => dest.emit("error", er);
      src.on("error", this.proxyErrors);
    }
  }

  class Minipass extends Stream {
    constructor(options) {
      super();
      this[FLOWING] = false;
      this[PAUSED] = false;
      this[PIPES] = [];
      this[BUFFER] = [];
      this[OBJECTMODE] = options && options.objectMode || false;
      if (this[OBJECTMODE])
        this[ENCODING] = null;
      else
        this[ENCODING] = options && options.encoding || null;
      if (this[ENCODING] === "buffer")
        this[ENCODING] = null;
      this[ASYNC] = options && !!options.async || false;
      this[DECODER] = this[ENCODING] ? new SD(this[ENCODING]) : null;
      this[EOF] = false;
      this[EMITTED_END] = false;
      this[EMITTING_END] = false;
      this[CLOSED] = false;
      this[EMITTED_ERROR] = null;
      this.writable = true;
      this.readable = true;
      this[BUFFERLENGTH] = 0;
      this[DESTROYED] = false;
      if (options && options.debugExposeBuffer === true) {
        Object.defineProperty(this, "buffer", { get: () => this[BUFFER] });
      }
      if (options && options.debugExposePipes === true) {
        Object.defineProperty(this, "pipes", { get: () => this[PIPES] });
      }
      this[SIGNAL] = options && options.signal;
      this[ABORTED] = false;
      if (this[SIGNAL]) {
        this[SIGNAL].addEventListener("abort", () => this[ABORT]());
        if (this[SIGNAL].aborted) {
          this[ABORT]();
        }
      }
    }
    get bufferLength() {
      return this[BUFFERLENGTH];
    }
    get encoding() {
      return this[ENCODING];
    }
    set encoding(enc) {
      if (this[OBJECTMODE])
        throw new Error("cannot set encoding in objectMode");
      if (this[ENCODING] && enc !== this[ENCODING] && (this[DECODER] && this[DECODER].lastNeed || this[BUFFERLENGTH]))
        throw new Error("cannot change encoding");
      if (this[ENCODING] !== enc) {
        this[DECODER] = enc ? new SD(enc) : null;
        if (this[BUFFER].length)
          this[BUFFER] = this[BUFFER].map((chunk) => this[DECODER].write(chunk));
      }
      this[ENCODING] = enc;
    }
    setEncoding(enc) {
      this.encoding = enc;
    }
    get objectMode() {
      return this[OBJECTMODE];
    }
    set objectMode(om) {
      this[OBJECTMODE] = this[OBJECTMODE] || !!om;
    }
    get ["async"]() {
      return this[ASYNC];
    }
    set ["async"](a) {
      this[ASYNC] = this[ASYNC] || !!a;
    }
    [ABORT]() {
      this[ABORTED] = true;
      this.emit("abort", this[SIGNAL].reason);
      this.destroy(this[SIGNAL].reason);
    }
    get aborted() {
      return this[ABORTED];
    }
    set aborted(_) {}
    write(chunk, encoding, cb) {
      if (this[ABORTED])
        return false;
      if (this[EOF])
        throw new Error("write after end");
      if (this[DESTROYED]) {
        this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }));
        return true;
      }
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (!encoding)
        encoding = "utf8";
      const fn = this[ASYNC] ? defer : (f) => f();
      if (!this[OBJECTMODE] && !Buffer.isBuffer(chunk)) {
        if (isArrayBufferView(chunk))
          chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        else if (isArrayBuffer(chunk))
          chunk = Buffer.from(chunk);
        else if (typeof chunk !== "string")
          this.objectMode = true;
      }
      if (this[OBJECTMODE]) {
        if (this.flowing && this[BUFFERLENGTH] !== 0)
          this[FLUSH](true);
        if (this.flowing)
          this.emit("data", chunk);
        else
          this[BUFFERPUSH](chunk);
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (!chunk.length) {
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (typeof chunk === "string" && !(encoding === this[ENCODING] && !this[DECODER].lastNeed)) {
        chunk = Buffer.from(chunk, encoding);
      }
      if (Buffer.isBuffer(chunk) && this[ENCODING])
        chunk = this[DECODER].write(chunk);
      if (this.flowing && this[BUFFERLENGTH] !== 0)
        this[FLUSH](true);
      if (this.flowing)
        this.emit("data", chunk);
      else
        this[BUFFERPUSH](chunk);
      if (this[BUFFERLENGTH] !== 0)
        this.emit("readable");
      if (cb)
        fn(cb);
      return this.flowing;
    }
    read(n) {
      if (this[DESTROYED])
        return null;
      if (this[BUFFERLENGTH] === 0 || n === 0 || n > this[BUFFERLENGTH]) {
        this[MAYBE_EMIT_END]();
        return null;
      }
      if (this[OBJECTMODE])
        n = null;
      if (this[BUFFER].length > 1 && !this[OBJECTMODE]) {
        if (this.encoding)
          this[BUFFER] = [this[BUFFER].join("")];
        else
          this[BUFFER] = [Buffer.concat(this[BUFFER], this[BUFFERLENGTH])];
      }
      const ret = this[READ](n || null, this[BUFFER][0]);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [READ](n, chunk) {
      if (n === chunk.length || n === null)
        this[BUFFERSHIFT]();
      else {
        this[BUFFER][0] = chunk.slice(n);
        chunk = chunk.slice(0, n);
        this[BUFFERLENGTH] -= n;
      }
      this.emit("data", chunk);
      if (!this[BUFFER].length && !this[EOF])
        this.emit("drain");
      return chunk;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function")
        cb = chunk, chunk = null;
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (chunk)
        this.write(chunk, encoding);
      if (cb)
        this.once("end", cb);
      this[EOF] = true;
      this.writable = false;
      if (this.flowing || !this[PAUSED])
        this[MAYBE_EMIT_END]();
      return this;
    }
    [RESUME]() {
      if (this[DESTROYED])
        return;
      this[PAUSED] = false;
      this[FLOWING] = true;
      this.emit("resume");
      if (this[BUFFER].length)
        this[FLUSH]();
      else if (this[EOF])
        this[MAYBE_EMIT_END]();
      else
        this.emit("drain");
    }
    resume() {
      return this[RESUME]();
    }
    pause() {
      this[FLOWING] = false;
      this[PAUSED] = true;
    }
    get destroyed() {
      return this[DESTROYED];
    }
    get flowing() {
      return this[FLOWING];
    }
    get paused() {
      return this[PAUSED];
    }
    [BUFFERPUSH](chunk) {
      if (this[OBJECTMODE])
        this[BUFFERLENGTH] += 1;
      else
        this[BUFFERLENGTH] += chunk.length;
      this[BUFFER].push(chunk);
    }
    [BUFFERSHIFT]() {
      if (this[OBJECTMODE])
        this[BUFFERLENGTH] -= 1;
      else
        this[BUFFERLENGTH] -= this[BUFFER][0].length;
      return this[BUFFER].shift();
    }
    [FLUSH](noDrain) {
      do {} while (this[FLUSHCHUNK](this[BUFFERSHIFT]()) && this[BUFFER].length);
      if (!noDrain && !this[BUFFER].length && !this[EOF])
        this.emit("drain");
    }
    [FLUSHCHUNK](chunk) {
      this.emit("data", chunk);
      return this.flowing;
    }
    pipe(dest, opts) {
      if (this[DESTROYED])
        return;
      const ended = this[EMITTED_END];
      opts = opts || {};
      if (dest === proc.stdout || dest === proc.stderr)
        opts.end = false;
      else
        opts.end = opts.end !== false;
      opts.proxyErrors = !!opts.proxyErrors;
      if (ended) {
        if (opts.end)
          dest.end();
      } else {
        this[PIPES].push(!opts.proxyErrors ? new Pipe(this, dest, opts) : new PipeProxyErrors(this, dest, opts));
        if (this[ASYNC])
          defer(() => this[RESUME]());
        else
          this[RESUME]();
      }
      return dest;
    }
    unpipe(dest) {
      const p = this[PIPES].find((p2) => p2.dest === dest);
      if (p) {
        this[PIPES].splice(this[PIPES].indexOf(p), 1);
        p.unpipe();
      }
    }
    addListener(ev, fn) {
      return this.on(ev, fn);
    }
    on(ev, fn) {
      const ret = super.on(ev, fn);
      if (ev === "data" && !this[PIPES].length && !this.flowing)
        this[RESUME]();
      else if (ev === "readable" && this[BUFFERLENGTH] !== 0)
        super.emit("readable");
      else if (isEndish(ev) && this[EMITTED_END]) {
        super.emit(ev);
        this.removeAllListeners(ev);
      } else if (ev === "error" && this[EMITTED_ERROR]) {
        if (this[ASYNC])
          defer(() => fn.call(this, this[EMITTED_ERROR]));
        else
          fn.call(this, this[EMITTED_ERROR]);
      }
      return ret;
    }
    get emittedEnd() {
      return this[EMITTED_END];
    }
    [MAYBE_EMIT_END]() {
      if (!this[EMITTING_END] && !this[EMITTED_END] && !this[DESTROYED] && this[BUFFER].length === 0 && this[EOF]) {
        this[EMITTING_END] = true;
        this.emit("end");
        this.emit("prefinish");
        this.emit("finish");
        if (this[CLOSED])
          this.emit("close");
        this[EMITTING_END] = false;
      }
    }
    emit(ev, data, ...extra) {
      if (ev !== "error" && ev !== "close" && ev !== DESTROYED && this[DESTROYED])
        return;
      else if (ev === "data") {
        return !this[OBJECTMODE] && !data ? false : this[ASYNC] ? defer(() => this[EMITDATA](data)) : this[EMITDATA](data);
      } else if (ev === "end") {
        return this[EMITEND]();
      } else if (ev === "close") {
        this[CLOSED] = true;
        if (!this[EMITTED_END] && !this[DESTROYED])
          return;
        const ret2 = super.emit("close");
        this.removeAllListeners("close");
        return ret2;
      } else if (ev === "error") {
        this[EMITTED_ERROR] = data;
        super.emit(ERROR, data);
        const ret2 = !this[SIGNAL] || this.listeners("error").length ? super.emit("error", data) : false;
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "resume") {
        const ret2 = super.emit("resume");
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "finish" || ev === "prefinish") {
        const ret2 = super.emit(ev);
        this.removeAllListeners(ev);
        return ret2;
      }
      const ret = super.emit(ev, data, ...extra);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITDATA](data) {
      for (const p of this[PIPES]) {
        if (p.dest.write(data) === false)
          this.pause();
      }
      const ret = super.emit("data", data);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITEND]() {
      if (this[EMITTED_END])
        return;
      this[EMITTED_END] = true;
      this.readable = false;
      if (this[ASYNC])
        defer(() => this[EMITEND2]());
      else
        this[EMITEND2]();
    }
    [EMITEND2]() {
      if (this[DECODER]) {
        const data = this[DECODER].end();
        if (data) {
          for (const p of this[PIPES]) {
            p.dest.write(data);
          }
          super.emit("data", data);
        }
      }
      for (const p of this[PIPES]) {
        p.end();
      }
      const ret = super.emit("end");
      this.removeAllListeners("end");
      return ret;
    }
    collect() {
      const buf = [];
      if (!this[OBJECTMODE])
        buf.dataLength = 0;
      const p = this.promise();
      this.on("data", (c) => {
        buf.push(c);
        if (!this[OBJECTMODE])
          buf.dataLength += c.length;
      });
      return p.then(() => buf);
    }
    concat() {
      return this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this.collect().then((buf) => this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this[ENCODING] ? buf.join("") : Buffer.concat(buf, buf.dataLength));
    }
    promise() {
      return new Promise((resolve, reject) => {
        this.on(DESTROYED, () => reject(new Error("stream destroyed")));
        this.on("error", (er) => reject(er));
        this.on("end", () => resolve());
      });
    }
    [ASYNCITERATOR]() {
      let stopped = false;
      const stop = () => {
        this.pause();
        stopped = true;
        return Promise.resolve({ done: true });
      };
      const next = () => {
        if (stopped)
          return stop();
        const res = this.read();
        if (res !== null)
          return Promise.resolve({ done: false, value: res });
        if (this[EOF])
          return stop();
        let resolve = null;
        let reject = null;
        const onerr = (er) => {
          this.removeListener("data", ondata);
          this.removeListener("end", onend);
          this.removeListener(DESTROYED, ondestroy);
          stop();
          reject(er);
        };
        const ondata = (value) => {
          this.removeListener("error", onerr);
          this.removeListener("end", onend);
          this.removeListener(DESTROYED, ondestroy);
          this.pause();
          resolve({ value, done: !!this[EOF] });
        };
        const onend = () => {
          this.removeListener("error", onerr);
          this.removeListener("data", ondata);
          this.removeListener(DESTROYED, ondestroy);
          stop();
          resolve({ done: true });
        };
        const ondestroy = () => onerr(new Error("stream destroyed"));
        return new Promise((res2, rej) => {
          reject = rej;
          resolve = res2;
          this.once(DESTROYED, ondestroy);
          this.once("error", onerr);
          this.once("end", onend);
          this.once("data", ondata);
        });
      };
      return {
        next,
        throw: stop,
        return: stop,
        [ASYNCITERATOR]() {
          return this;
        }
      };
    }
    [ITERATOR]() {
      let stopped = false;
      const stop = () => {
        this.pause();
        this.removeListener(ERROR, stop);
        this.removeListener(DESTROYED, stop);
        this.removeListener("end", stop);
        stopped = true;
        return { done: true };
      };
      const next = () => {
        if (stopped)
          return stop();
        const value = this.read();
        return value === null ? stop() : { value };
      };
      this.once("end", stop);
      this.once(ERROR, stop);
      this.once(DESTROYED, stop);
      return {
        next,
        throw: stop,
        return: stop,
        [ITERATOR]() {
          return this;
        }
      };
    }
    destroy(er) {
      if (this[DESTROYED]) {
        if (er)
          this.emit("error", er);
        else
          this.emit(DESTROYED);
        return this;
      }
      this[DESTROYED] = true;
      this[BUFFER].length = 0;
      this[BUFFERLENGTH] = 0;
      if (typeof this.close === "function" && !this[CLOSED])
        this.close();
      if (er)
        this.emit("error", er);
      else
        this.emit(DESTROYED);
      return this;
    }
    static isStream(s) {
      return !!s && (s instanceof Minipass || s instanceof Stream || s instanceof EE && (typeof s.pipe === "function" || typeof s.write === "function" && typeof s.end === "function"));
    }
  }
  exports.Minipass = Minipass;
});

// ../../node_modules/minizlib/constants.js
var require_constants = __commonJS((exports, module) => {
  var realZlibConstants = __require("zlib").constants || { ZLIB_VERNUM: 4736 };
  module.exports = Object.freeze(Object.assign(Object.create(null), {
    Z_NO_FLUSH: 0,
    Z_PARTIAL_FLUSH: 1,
    Z_SYNC_FLUSH: 2,
    Z_FULL_FLUSH: 3,
    Z_FINISH: 4,
    Z_BLOCK: 5,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0,
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1,
    Z_HUFFMAN_ONLY: 2,
    Z_RLE: 3,
    Z_FIXED: 4,
    Z_DEFAULT_STRATEGY: 0,
    DEFLATE: 1,
    INFLATE: 2,
    GZIP: 3,
    GUNZIP: 4,
    DEFLATERAW: 5,
    INFLATERAW: 6,
    UNZIP: 7,
    BROTLI_DECODE: 8,
    BROTLI_ENCODE: 9,
    Z_MIN_WINDOWBITS: 8,
    Z_MAX_WINDOWBITS: 15,
    Z_DEFAULT_WINDOWBITS: 15,
    Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity,
    Z_DEFAULT_CHUNK: 16384,
    Z_MIN_MEMLEVEL: 1,
    Z_MAX_MEMLEVEL: 9,
    Z_DEFAULT_MEMLEVEL: 8,
    Z_MIN_LEVEL: -1,
    Z_MAX_LEVEL: 9,
    Z_DEFAULT_LEVEL: -1,
    BROTLI_OPERATION_PROCESS: 0,
    BROTLI_OPERATION_FLUSH: 1,
    BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3,
    BROTLI_MODE_GENERIC: 0,
    BROTLI_MODE_TEXT: 1,
    BROTLI_MODE_FONT: 2,
    BROTLI_DEFAULT_MODE: 0,
    BROTLI_MIN_QUALITY: 0,
    BROTLI_MAX_QUALITY: 11,
    BROTLI_DEFAULT_QUALITY: 11,
    BROTLI_MIN_WINDOW_BITS: 10,
    BROTLI_MAX_WINDOW_BITS: 24,
    BROTLI_LARGE_MAX_WINDOW_BITS: 30,
    BROTLI_DEFAULT_WINDOW: 22,
    BROTLI_MIN_INPUT_BLOCK_BITS: 16,
    BROTLI_MAX_INPUT_BLOCK_BITS: 24,
    BROTLI_PARAM_MODE: 0,
    BROTLI_PARAM_QUALITY: 1,
    BROTLI_PARAM_LGWIN: 2,
    BROTLI_PARAM_LGBLOCK: 3,
    BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
    BROTLI_PARAM_SIZE_HINT: 5,
    BROTLI_PARAM_LARGE_WINDOW: 6,
    BROTLI_PARAM_NPOSTFIX: 7,
    BROTLI_PARAM_NDIRECT: 8,
    BROTLI_DECODER_RESULT_ERROR: 0,
    BROTLI_DECODER_RESULT_SUCCESS: 1,
    BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
    BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
    BROTLI_DECODER_NO_ERROR: 0,
    BROTLI_DECODER_SUCCESS: 1,
    BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
    BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
    BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
    BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
    BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
    BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
    BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
    BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
    BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
    BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
    BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
    BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
    BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
    BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
    BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
    BROTLI_DECODER_ERROR_UNREACHABLE: -31
  }, realZlibConstants));
});

// ../../node_modules/minizlib/node_modules/minipass/index.js
var require_minipass2 = __commonJS((exports, module) => {
  var proc = typeof process === "object" && process ? process : {
    stdout: null,
    stderr: null
  };
  var EE = __require("events");
  var Stream = __require("stream");
  var SD = __require("string_decoder").StringDecoder;
  var EOF = Symbol("EOF");
  var MAYBE_EMIT_END = Symbol("maybeEmitEnd");
  var EMITTED_END = Symbol("emittedEnd");
  var EMITTING_END = Symbol("emittingEnd");
  var EMITTED_ERROR = Symbol("emittedError");
  var CLOSED = Symbol("closed");
  var READ = Symbol("read");
  var FLUSH = Symbol("flush");
  var FLUSHCHUNK = Symbol("flushChunk");
  var ENCODING = Symbol("encoding");
  var DECODER = Symbol("decoder");
  var FLOWING = Symbol("flowing");
  var PAUSED = Symbol("paused");
  var RESUME = Symbol("resume");
  var BUFFERLENGTH = Symbol("bufferLength");
  var BUFFERPUSH = Symbol("bufferPush");
  var BUFFERSHIFT = Symbol("bufferShift");
  var OBJECTMODE = Symbol("objectMode");
  var DESTROYED = Symbol("destroyed");
  var EMITDATA = Symbol("emitData");
  var EMITEND = Symbol("emitEnd");
  var EMITEND2 = Symbol("emitEnd2");
  var ASYNC = Symbol("async");
  var defer = (fn) => Promise.resolve().then(fn);
  var doIter = global._MP_NO_ITERATOR_SYMBOLS_ !== "1";
  var ASYNCITERATOR = doIter && Symbol.asyncIterator || Symbol("asyncIterator not implemented");
  var ITERATOR = doIter && Symbol.iterator || Symbol("iterator not implemented");
  var isEndish = (ev) => ev === "end" || ev === "finish" || ev === "prefinish";
  var isArrayBuffer = (b) => b instanceof ArrayBuffer || typeof b === "object" && b.constructor && b.constructor.name === "ArrayBuffer" && b.byteLength >= 0;
  var isArrayBufferView = (b) => !Buffer.isBuffer(b) && ArrayBuffer.isView(b);

  class Pipe {
    constructor(src, dest, opts) {
      this.src = src;
      this.dest = dest;
      this.opts = opts;
      this.ondrain = () => src[RESUME]();
      dest.on("drain", this.ondrain);
    }
    unpipe() {
      this.dest.removeListener("drain", this.ondrain);
    }
    proxyErrors() {}
    end() {
      this.unpipe();
      if (this.opts.end)
        this.dest.end();
    }
  }

  class PipeProxyErrors extends Pipe {
    unpipe() {
      this.src.removeListener("error", this.proxyErrors);
      super.unpipe();
    }
    constructor(src, dest, opts) {
      super(src, dest, opts);
      this.proxyErrors = (er) => dest.emit("error", er);
      src.on("error", this.proxyErrors);
    }
  }
  module.exports = class Minipass extends Stream {
    constructor(options) {
      super();
      this[FLOWING] = false;
      this[PAUSED] = false;
      this.pipes = [];
      this.buffer = [];
      this[OBJECTMODE] = options && options.objectMode || false;
      if (this[OBJECTMODE])
        this[ENCODING] = null;
      else
        this[ENCODING] = options && options.encoding || null;
      if (this[ENCODING] === "buffer")
        this[ENCODING] = null;
      this[ASYNC] = options && !!options.async || false;
      this[DECODER] = this[ENCODING] ? new SD(this[ENCODING]) : null;
      this[EOF] = false;
      this[EMITTED_END] = false;
      this[EMITTING_END] = false;
      this[CLOSED] = false;
      this[EMITTED_ERROR] = null;
      this.writable = true;
      this.readable = true;
      this[BUFFERLENGTH] = 0;
      this[DESTROYED] = false;
    }
    get bufferLength() {
      return this[BUFFERLENGTH];
    }
    get encoding() {
      return this[ENCODING];
    }
    set encoding(enc) {
      if (this[OBJECTMODE])
        throw new Error("cannot set encoding in objectMode");
      if (this[ENCODING] && enc !== this[ENCODING] && (this[DECODER] && this[DECODER].lastNeed || this[BUFFERLENGTH]))
        throw new Error("cannot change encoding");
      if (this[ENCODING] !== enc) {
        this[DECODER] = enc ? new SD(enc) : null;
        if (this.buffer.length)
          this.buffer = this.buffer.map((chunk) => this[DECODER].write(chunk));
      }
      this[ENCODING] = enc;
    }
    setEncoding(enc) {
      this.encoding = enc;
    }
    get objectMode() {
      return this[OBJECTMODE];
    }
    set objectMode(om) {
      this[OBJECTMODE] = this[OBJECTMODE] || !!om;
    }
    get ["async"]() {
      return this[ASYNC];
    }
    set ["async"](a) {
      this[ASYNC] = this[ASYNC] || !!a;
    }
    write(chunk, encoding, cb) {
      if (this[EOF])
        throw new Error("write after end");
      if (this[DESTROYED]) {
        this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }));
        return true;
      }
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (!encoding)
        encoding = "utf8";
      const fn = this[ASYNC] ? defer : (f) => f();
      if (!this[OBJECTMODE] && !Buffer.isBuffer(chunk)) {
        if (isArrayBufferView(chunk))
          chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        else if (isArrayBuffer(chunk))
          chunk = Buffer.from(chunk);
        else if (typeof chunk !== "string")
          this.objectMode = true;
      }
      if (this[OBJECTMODE]) {
        if (this.flowing && this[BUFFERLENGTH] !== 0)
          this[FLUSH](true);
        if (this.flowing)
          this.emit("data", chunk);
        else
          this[BUFFERPUSH](chunk);
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (!chunk.length) {
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (typeof chunk === "string" && !(encoding === this[ENCODING] && !this[DECODER].lastNeed)) {
        chunk = Buffer.from(chunk, encoding);
      }
      if (Buffer.isBuffer(chunk) && this[ENCODING])
        chunk = this[DECODER].write(chunk);
      if (this.flowing && this[BUFFERLENGTH] !== 0)
        this[FLUSH](true);
      if (this.flowing)
        this.emit("data", chunk);
      else
        this[BUFFERPUSH](chunk);
      if (this[BUFFERLENGTH] !== 0)
        this.emit("readable");
      if (cb)
        fn(cb);
      return this.flowing;
    }
    read(n) {
      if (this[DESTROYED])
        return null;
      if (this[BUFFERLENGTH] === 0 || n === 0 || n > this[BUFFERLENGTH]) {
        this[MAYBE_EMIT_END]();
        return null;
      }
      if (this[OBJECTMODE])
        n = null;
      if (this.buffer.length > 1 && !this[OBJECTMODE]) {
        if (this.encoding)
          this.buffer = [this.buffer.join("")];
        else
          this.buffer = [Buffer.concat(this.buffer, this[BUFFERLENGTH])];
      }
      const ret = this[READ](n || null, this.buffer[0]);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [READ](n, chunk) {
      if (n === chunk.length || n === null)
        this[BUFFERSHIFT]();
      else {
        this.buffer[0] = chunk.slice(n);
        chunk = chunk.slice(0, n);
        this[BUFFERLENGTH] -= n;
      }
      this.emit("data", chunk);
      if (!this.buffer.length && !this[EOF])
        this.emit("drain");
      return chunk;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function")
        cb = chunk, chunk = null;
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (chunk)
        this.write(chunk, encoding);
      if (cb)
        this.once("end", cb);
      this[EOF] = true;
      this.writable = false;
      if (this.flowing || !this[PAUSED])
        this[MAYBE_EMIT_END]();
      return this;
    }
    [RESUME]() {
      if (this[DESTROYED])
        return;
      this[PAUSED] = false;
      this[FLOWING] = true;
      this.emit("resume");
      if (this.buffer.length)
        this[FLUSH]();
      else if (this[EOF])
        this[MAYBE_EMIT_END]();
      else
        this.emit("drain");
    }
    resume() {
      return this[RESUME]();
    }
    pause() {
      this[FLOWING] = false;
      this[PAUSED] = true;
    }
    get destroyed() {
      return this[DESTROYED];
    }
    get flowing() {
      return this[FLOWING];
    }
    get paused() {
      return this[PAUSED];
    }
    [BUFFERPUSH](chunk) {
      if (this[OBJECTMODE])
        this[BUFFERLENGTH] += 1;
      else
        this[BUFFERLENGTH] += chunk.length;
      this.buffer.push(chunk);
    }
    [BUFFERSHIFT]() {
      if (this.buffer.length) {
        if (this[OBJECTMODE])
          this[BUFFERLENGTH] -= 1;
        else
          this[BUFFERLENGTH] -= this.buffer[0].length;
      }
      return this.buffer.shift();
    }
    [FLUSH](noDrain) {
      do {} while (this[FLUSHCHUNK](this[BUFFERSHIFT]()));
      if (!noDrain && !this.buffer.length && !this[EOF])
        this.emit("drain");
    }
    [FLUSHCHUNK](chunk) {
      return chunk ? (this.emit("data", chunk), this.flowing) : false;
    }
    pipe(dest, opts) {
      if (this[DESTROYED])
        return;
      const ended = this[EMITTED_END];
      opts = opts || {};
      if (dest === proc.stdout || dest === proc.stderr)
        opts.end = false;
      else
        opts.end = opts.end !== false;
      opts.proxyErrors = !!opts.proxyErrors;
      if (ended) {
        if (opts.end)
          dest.end();
      } else {
        this.pipes.push(!opts.proxyErrors ? new Pipe(this, dest, opts) : new PipeProxyErrors(this, dest, opts));
        if (this[ASYNC])
          defer(() => this[RESUME]());
        else
          this[RESUME]();
      }
      return dest;
    }
    unpipe(dest) {
      const p = this.pipes.find((p2) => p2.dest === dest);
      if (p) {
        this.pipes.splice(this.pipes.indexOf(p), 1);
        p.unpipe();
      }
    }
    addListener(ev, fn) {
      return this.on(ev, fn);
    }
    on(ev, fn) {
      const ret = super.on(ev, fn);
      if (ev === "data" && !this.pipes.length && !this.flowing)
        this[RESUME]();
      else if (ev === "readable" && this[BUFFERLENGTH] !== 0)
        super.emit("readable");
      else if (isEndish(ev) && this[EMITTED_END]) {
        super.emit(ev);
        this.removeAllListeners(ev);
      } else if (ev === "error" && this[EMITTED_ERROR]) {
        if (this[ASYNC])
          defer(() => fn.call(this, this[EMITTED_ERROR]));
        else
          fn.call(this, this[EMITTED_ERROR]);
      }
      return ret;
    }
    get emittedEnd() {
      return this[EMITTED_END];
    }
    [MAYBE_EMIT_END]() {
      if (!this[EMITTING_END] && !this[EMITTED_END] && !this[DESTROYED] && this.buffer.length === 0 && this[EOF]) {
        this[EMITTING_END] = true;
        this.emit("end");
        this.emit("prefinish");
        this.emit("finish");
        if (this[CLOSED])
          this.emit("close");
        this[EMITTING_END] = false;
      }
    }
    emit(ev, data, ...extra) {
      if (ev !== "error" && ev !== "close" && ev !== DESTROYED && this[DESTROYED])
        return;
      else if (ev === "data") {
        return !data ? false : this[ASYNC] ? defer(() => this[EMITDATA](data)) : this[EMITDATA](data);
      } else if (ev === "end") {
        return this[EMITEND]();
      } else if (ev === "close") {
        this[CLOSED] = true;
        if (!this[EMITTED_END] && !this[DESTROYED])
          return;
        const ret2 = super.emit("close");
        this.removeAllListeners("close");
        return ret2;
      } else if (ev === "error") {
        this[EMITTED_ERROR] = data;
        const ret2 = super.emit("error", data);
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "resume") {
        const ret2 = super.emit("resume");
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "finish" || ev === "prefinish") {
        const ret2 = super.emit(ev);
        this.removeAllListeners(ev);
        return ret2;
      }
      const ret = super.emit(ev, data, ...extra);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITDATA](data) {
      for (const p of this.pipes) {
        if (p.dest.write(data) === false)
          this.pause();
      }
      const ret = super.emit("data", data);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITEND]() {
      if (this[EMITTED_END])
        return;
      this[EMITTED_END] = true;
      this.readable = false;
      if (this[ASYNC])
        defer(() => this[EMITEND2]());
      else
        this[EMITEND2]();
    }
    [EMITEND2]() {
      if (this[DECODER]) {
        const data = this[DECODER].end();
        if (data) {
          for (const p of this.pipes) {
            p.dest.write(data);
          }
          super.emit("data", data);
        }
      }
      for (const p of this.pipes) {
        p.end();
      }
      const ret = super.emit("end");
      this.removeAllListeners("end");
      return ret;
    }
    collect() {
      const buf = [];
      if (!this[OBJECTMODE])
        buf.dataLength = 0;
      const p = this.promise();
      this.on("data", (c) => {
        buf.push(c);
        if (!this[OBJECTMODE])
          buf.dataLength += c.length;
      });
      return p.then(() => buf);
    }
    concat() {
      return this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this.collect().then((buf) => this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this[ENCODING] ? buf.join("") : Buffer.concat(buf, buf.dataLength));
    }
    promise() {
      return new Promise((resolve, reject) => {
        this.on(DESTROYED, () => reject(new Error("stream destroyed")));
        this.on("error", (er) => reject(er));
        this.on("end", () => resolve());
      });
    }
    [ASYNCITERATOR]() {
      const next = () => {
        const res = this.read();
        if (res !== null)
          return Promise.resolve({ done: false, value: res });
        if (this[EOF])
          return Promise.resolve({ done: true });
        let resolve = null;
        let reject = null;
        const onerr = (er) => {
          this.removeListener("data", ondata);
          this.removeListener("end", onend);
          reject(er);
        };
        const ondata = (value) => {
          this.removeListener("error", onerr);
          this.removeListener("end", onend);
          this.pause();
          resolve({ value, done: !!this[EOF] });
        };
        const onend = () => {
          this.removeListener("error", onerr);
          this.removeListener("data", ondata);
          resolve({ done: true });
        };
        const ondestroy = () => onerr(new Error("stream destroyed"));
        return new Promise((res2, rej) => {
          reject = rej;
          resolve = res2;
          this.once(DESTROYED, ondestroy);
          this.once("error", onerr);
          this.once("end", onend);
          this.once("data", ondata);
        });
      };
      return { next };
    }
    [ITERATOR]() {
      const next = () => {
        const value = this.read();
        const done = value === null;
        return { value, done };
      };
      return { next };
    }
    destroy(er) {
      if (this[DESTROYED]) {
        if (er)
          this.emit("error", er);
        else
          this.emit(DESTROYED);
        return this;
      }
      this[DESTROYED] = true;
      this.buffer.length = 0;
      this[BUFFERLENGTH] = 0;
      if (typeof this.close === "function" && !this[CLOSED])
        this.close();
      if (er)
        this.emit("error", er);
      else
        this.emit(DESTROYED);
      return this;
    }
    static isStream(s) {
      return !!s && (s instanceof Minipass || s instanceof Stream || s instanceof EE && (typeof s.pipe === "function" || typeof s.write === "function" && typeof s.end === "function"));
    }
  };
});

// ../../node_modules/minizlib/index.js
var require_minizlib = __commonJS((exports) => {
  var assert = __require("assert");
  var Buffer2 = __require("buffer").Buffer;
  var realZlib = __require("zlib");
  var constants = exports.constants = require_constants();
  var Minipass = require_minipass2();
  var OriginalBufferConcat = Buffer2.concat;
  var _superWrite = Symbol("_superWrite");

  class ZlibError extends Error {
    constructor(err) {
      super("zlib: " + err.message);
      this.code = err.code;
      this.errno = err.errno;
      if (!this.code)
        this.code = "ZLIB_ERROR";
      this.message = "zlib: " + err.message;
      Error.captureStackTrace(this, this.constructor);
    }
    get name() {
      return "ZlibError";
    }
  }
  var _opts = Symbol("opts");
  var _flushFlag = Symbol("flushFlag");
  var _finishFlushFlag = Symbol("finishFlushFlag");
  var _fullFlushFlag = Symbol("fullFlushFlag");
  var _handle = Symbol("handle");
  var _onError = Symbol("onError");
  var _sawError = Symbol("sawError");
  var _level = Symbol("level");
  var _strategy = Symbol("strategy");
  var _ended = Symbol("ended");
  var _defaultFullFlush = Symbol("_defaultFullFlush");

  class ZlibBase extends Minipass {
    constructor(opts, mode) {
      if (!opts || typeof opts !== "object")
        throw new TypeError("invalid options for ZlibBase constructor");
      super(opts);
      this[_sawError] = false;
      this[_ended] = false;
      this[_opts] = opts;
      this[_flushFlag] = opts.flush;
      this[_finishFlushFlag] = opts.finishFlush;
      try {
        this[_handle] = new realZlib[mode](opts);
      } catch (er) {
        throw new ZlibError(er);
      }
      this[_onError] = (err) => {
        if (this[_sawError])
          return;
        this[_sawError] = true;
        this.close();
        this.emit("error", err);
      };
      this[_handle].on("error", (er) => this[_onError](new ZlibError(er)));
      this.once("end", () => this.close);
    }
    close() {
      if (this[_handle]) {
        this[_handle].close();
        this[_handle] = null;
        this.emit("close");
      }
    }
    reset() {
      if (!this[_sawError]) {
        assert(this[_handle], "zlib binding closed");
        return this[_handle].reset();
      }
    }
    flush(flushFlag) {
      if (this.ended)
        return;
      if (typeof flushFlag !== "number")
        flushFlag = this[_fullFlushFlag];
      this.write(Object.assign(Buffer2.alloc(0), { [_flushFlag]: flushFlag }));
    }
    end(chunk, encoding, cb) {
      if (chunk)
        this.write(chunk, encoding);
      this.flush(this[_finishFlushFlag]);
      this[_ended] = true;
      return super.end(null, null, cb);
    }
    get ended() {
      return this[_ended];
    }
    write(chunk, encoding, cb) {
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (typeof chunk === "string")
        chunk = Buffer2.from(chunk, encoding);
      if (this[_sawError])
        return;
      assert(this[_handle], "zlib binding closed");
      const nativeHandle = this[_handle]._handle;
      const originalNativeClose = nativeHandle.close;
      nativeHandle.close = () => {};
      const originalClose = this[_handle].close;
      this[_handle].close = () => {};
      Buffer2.concat = (args) => args;
      let result;
      try {
        const flushFlag = typeof chunk[_flushFlag] === "number" ? chunk[_flushFlag] : this[_flushFlag];
        result = this[_handle]._processChunk(chunk, flushFlag);
        Buffer2.concat = OriginalBufferConcat;
      } catch (err) {
        Buffer2.concat = OriginalBufferConcat;
        this[_onError](new ZlibError(err));
      } finally {
        if (this[_handle]) {
          this[_handle]._handle = nativeHandle;
          nativeHandle.close = originalNativeClose;
          this[_handle].close = originalClose;
          this[_handle].removeAllListeners("error");
        }
      }
      if (this[_handle])
        this[_handle].on("error", (er) => this[_onError](new ZlibError(er)));
      let writeReturn;
      if (result) {
        if (Array.isArray(result) && result.length > 0) {
          writeReturn = this[_superWrite](Buffer2.from(result[0]));
          for (let i = 1;i < result.length; i++) {
            writeReturn = this[_superWrite](result[i]);
          }
        } else {
          writeReturn = this[_superWrite](Buffer2.from(result));
        }
      }
      if (cb)
        cb();
      return writeReturn;
    }
    [_superWrite](data) {
      return super.write(data);
    }
  }

  class Zlib extends ZlibBase {
    constructor(opts, mode) {
      opts = opts || {};
      opts.flush = opts.flush || constants.Z_NO_FLUSH;
      opts.finishFlush = opts.finishFlush || constants.Z_FINISH;
      super(opts, mode);
      this[_fullFlushFlag] = constants.Z_FULL_FLUSH;
      this[_level] = opts.level;
      this[_strategy] = opts.strategy;
    }
    params(level, strategy) {
      if (this[_sawError])
        return;
      if (!this[_handle])
        throw new Error("cannot switch params when binding is closed");
      if (!this[_handle].params)
        throw new Error("not supported in this implementation");
      if (this[_level] !== level || this[_strategy] !== strategy) {
        this.flush(constants.Z_SYNC_FLUSH);
        assert(this[_handle], "zlib binding closed");
        const origFlush = this[_handle].flush;
        this[_handle].flush = (flushFlag, cb) => {
          this.flush(flushFlag);
          cb();
        };
        try {
          this[_handle].params(level, strategy);
        } finally {
          this[_handle].flush = origFlush;
        }
        if (this[_handle]) {
          this[_level] = level;
          this[_strategy] = strategy;
        }
      }
    }
  }

  class Deflate extends Zlib {
    constructor(opts) {
      super(opts, "Deflate");
    }
  }

  class Inflate extends Zlib {
    constructor(opts) {
      super(opts, "Inflate");
    }
  }
  var _portable = Symbol("_portable");

  class Gzip extends Zlib {
    constructor(opts) {
      super(opts, "Gzip");
      this[_portable] = opts && !!opts.portable;
    }
    [_superWrite](data) {
      if (!this[_portable])
        return super[_superWrite](data);
      this[_portable] = false;
      data[9] = 255;
      return super[_superWrite](data);
    }
  }

  class Gunzip extends Zlib {
    constructor(opts) {
      super(opts, "Gunzip");
    }
  }

  class DeflateRaw extends Zlib {
    constructor(opts) {
      super(opts, "DeflateRaw");
    }
  }

  class InflateRaw extends Zlib {
    constructor(opts) {
      super(opts, "InflateRaw");
    }
  }

  class Unzip extends Zlib {
    constructor(opts) {
      super(opts, "Unzip");
    }
  }

  class Brotli extends ZlibBase {
    constructor(opts, mode) {
      opts = opts || {};
      opts.flush = opts.flush || constants.BROTLI_OPERATION_PROCESS;
      opts.finishFlush = opts.finishFlush || constants.BROTLI_OPERATION_FINISH;
      super(opts, mode);
      this[_fullFlushFlag] = constants.BROTLI_OPERATION_FLUSH;
    }
  }

  class BrotliCompress extends Brotli {
    constructor(opts) {
      super(opts, "BrotliCompress");
    }
  }

  class BrotliDecompress extends Brotli {
    constructor(opts) {
      super(opts, "BrotliDecompress");
    }
  }
  exports.Deflate = Deflate;
  exports.Inflate = Inflate;
  exports.Gzip = Gzip;
  exports.Gunzip = Gunzip;
  exports.DeflateRaw = DeflateRaw;
  exports.InflateRaw = InflateRaw;
  exports.Unzip = Unzip;
  if (typeof realZlib.BrotliCompress === "function") {
    exports.BrotliCompress = BrotliCompress;
    exports.BrotliDecompress = BrotliDecompress;
  } else {
    exports.BrotliCompress = exports.BrotliDecompress = class {
      constructor() {
        throw new Error("Brotli is not supported in this version of Node.js");
      }
    };
  }
});

// ../../node_modules/tar/lib/normalize-windows-path.js
var require_normalize_windows_path = __commonJS((exports, module) => {
  var platform = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
  module.exports = platform !== "win32" ? (p) => p : (p) => p && p.replace(/\\/g, "/");
});

// ../../node_modules/tar/lib/read-entry.js
var require_read_entry = __commonJS((exports, module) => {
  var { Minipass } = require_minipass();
  var normPath = require_normalize_windows_path();
  var SLURP = Symbol("slurp");
  module.exports = class ReadEntry extends Minipass {
    constructor(header, ex, gex) {
      super();
      this.pause();
      this.extended = ex;
      this.globalExtended = gex;
      this.header = header;
      this.startBlockSize = 512 * Math.ceil(header.size / 512);
      this.blockRemain = this.startBlockSize;
      this.remain = header.size;
      this.type = header.type;
      this.meta = false;
      this.ignore = false;
      switch (this.type) {
        case "File":
        case "OldFile":
        case "Link":
        case "SymbolicLink":
        case "CharacterDevice":
        case "BlockDevice":
        case "Directory":
        case "FIFO":
        case "ContiguousFile":
        case "GNUDumpDir":
          break;
        case "NextFileHasLongLinkpath":
        case "NextFileHasLongPath":
        case "OldGnuLongPath":
        case "GlobalExtendedHeader":
        case "ExtendedHeader":
        case "OldExtendedHeader":
          this.meta = true;
          break;
        default:
          this.ignore = true;
      }
      this.path = normPath(header.path);
      this.mode = header.mode;
      if (this.mode) {
        this.mode = this.mode & 4095;
      }
      this.uid = header.uid;
      this.gid = header.gid;
      this.uname = header.uname;
      this.gname = header.gname;
      this.size = header.size;
      this.mtime = header.mtime;
      this.atime = header.atime;
      this.ctime = header.ctime;
      this.linkpath = normPath(header.linkpath);
      this.uname = header.uname;
      this.gname = header.gname;
      if (ex) {
        this[SLURP](ex);
      }
      if (gex) {
        this[SLURP](gex, true);
      }
    }
    write(data) {
      const writeLen = data.length;
      if (writeLen > this.blockRemain) {
        throw new Error("writing more to entry than is appropriate");
      }
      const r = this.remain;
      const br = this.blockRemain;
      this.remain = Math.max(0, r - writeLen);
      this.blockRemain = Math.max(0, br - writeLen);
      if (this.ignore) {
        return true;
      }
      if (r >= writeLen) {
        return super.write(data);
      }
      return super.write(data.slice(0, r));
    }
    [SLURP](ex, global2) {
      for (const k in ex) {
        if (ex[k] !== null && ex[k] !== undefined && !(global2 && k === "path")) {
          this[k] = k === "path" || k === "linkpath" ? normPath(ex[k]) : ex[k];
        }
      }
    }
  };
});

// ../../node_modules/tar/lib/types.js
var require_types = __commonJS((exports) => {
  exports.name = new Map([
    ["0", "File"],
    ["", "OldFile"],
    ["1", "Link"],
    ["2", "SymbolicLink"],
    ["3", "CharacterDevice"],
    ["4", "BlockDevice"],
    ["5", "Directory"],
    ["6", "FIFO"],
    ["7", "ContiguousFile"],
    ["g", "GlobalExtendedHeader"],
    ["x", "ExtendedHeader"],
    ["A", "SolarisACL"],
    ["D", "GNUDumpDir"],
    ["I", "Inode"],
    ["K", "NextFileHasLongLinkpath"],
    ["L", "NextFileHasLongPath"],
    ["M", "ContinuationFile"],
    ["N", "OldGnuLongPath"],
    ["S", "SparseFile"],
    ["V", "TapeVolumeHeader"],
    ["X", "OldExtendedHeader"]
  ]);
  exports.code = new Map(Array.from(exports.name).map((kv) => [kv[1], kv[0]]));
});

// ../../node_modules/tar/lib/large-numbers.js
var require_large_numbers = __commonJS((exports, module) => {
  var encode = (num, buf) => {
    if (!Number.isSafeInteger(num)) {
      throw Error("cannot encode number outside of javascript safe integer range");
    } else if (num < 0) {
      encodeNegative(num, buf);
    } else {
      encodePositive(num, buf);
    }
    return buf;
  };
  var encodePositive = (num, buf) => {
    buf[0] = 128;
    for (var i = buf.length;i > 1; i--) {
      buf[i - 1] = num & 255;
      num = Math.floor(num / 256);
    }
  };
  var encodeNegative = (num, buf) => {
    buf[0] = 255;
    var flipped = false;
    num = num * -1;
    for (var i = buf.length;i > 1; i--) {
      var byte = num & 255;
      num = Math.floor(num / 256);
      if (flipped) {
        buf[i - 1] = onesComp(byte);
      } else if (byte === 0) {
        buf[i - 1] = 0;
      } else {
        flipped = true;
        buf[i - 1] = twosComp(byte);
      }
    }
  };
  var parse = (buf) => {
    const pre = buf[0];
    const value = pre === 128 ? pos(buf.slice(1, buf.length)) : pre === 255 ? twos(buf) : null;
    if (value === null) {
      throw Error("invalid base256 encoding");
    }
    if (!Number.isSafeInteger(value)) {
      throw Error("parsed number outside of javascript safe integer range");
    }
    return value;
  };
  var twos = (buf) => {
    var len = buf.length;
    var sum = 0;
    var flipped = false;
    for (var i = len - 1;i > -1; i--) {
      var byte = buf[i];
      var f;
      if (flipped) {
        f = onesComp(byte);
      } else if (byte === 0) {
        f = byte;
      } else {
        flipped = true;
        f = twosComp(byte);
      }
      if (f !== 0) {
        sum -= f * Math.pow(256, len - i - 1);
      }
    }
    return sum;
  };
  var pos = (buf) => {
    var len = buf.length;
    var sum = 0;
    for (var i = len - 1;i > -1; i--) {
      var byte = buf[i];
      if (byte !== 0) {
        sum += byte * Math.pow(256, len - i - 1);
      }
    }
    return sum;
  };
  var onesComp = (byte) => (255 ^ byte) & 255;
  var twosComp = (byte) => (255 ^ byte) + 1 & 255;
  module.exports = {
    encode,
    parse
  };
});

// ../../node_modules/tar/lib/header.js
var require_header = __commonJS((exports, module) => {
  var types = require_types();
  var pathModule = __require("path").posix;
  var large = require_large_numbers();
  var SLURP = Symbol("slurp");
  var TYPE = Symbol("type");

  class Header {
    constructor(data, off, ex, gex) {
      this.cksumValid = false;
      this.needPax = false;
      this.nullBlock = false;
      this.block = null;
      this.path = null;
      this.mode = null;
      this.uid = null;
      this.gid = null;
      this.size = null;
      this.mtime = null;
      this.cksum = null;
      this[TYPE] = "0";
      this.linkpath = null;
      this.uname = null;
      this.gname = null;
      this.devmaj = 0;
      this.devmin = 0;
      this.atime = null;
      this.ctime = null;
      if (Buffer.isBuffer(data)) {
        this.decode(data, off || 0, ex, gex);
      } else if (data) {
        this.set(data);
      }
    }
    decode(buf, off, ex, gex) {
      if (!off) {
        off = 0;
      }
      if (!buf || !(buf.length >= off + 512)) {
        throw new Error("need 512 bytes for header");
      }
      this.path = decString(buf, off, 100);
      this.mode = decNumber(buf, off + 100, 8);
      this.uid = decNumber(buf, off + 108, 8);
      this.gid = decNumber(buf, off + 116, 8);
      this.size = decNumber(buf, off + 124, 12);
      this.mtime = decDate(buf, off + 136, 12);
      this.cksum = decNumber(buf, off + 148, 12);
      this[SLURP](ex);
      this[SLURP](gex, true);
      this[TYPE] = decString(buf, off + 156, 1);
      if (this[TYPE] === "") {
        this[TYPE] = "0";
      }
      if (this[TYPE] === "0" && this.path.slice(-1) === "/") {
        this[TYPE] = "5";
      }
      if (this[TYPE] === "5") {
        this.size = 0;
      }
      this.linkpath = decString(buf, off + 157, 100);
      if (buf.slice(off + 257, off + 265).toString() === "ustar\x0000") {
        this.uname = decString(buf, off + 265, 32);
        this.gname = decString(buf, off + 297, 32);
        this.devmaj = decNumber(buf, off + 329, 8);
        this.devmin = decNumber(buf, off + 337, 8);
        if (buf[off + 475] !== 0) {
          const prefix = decString(buf, off + 345, 155);
          this.path = prefix + "/" + this.path;
        } else {
          const prefix = decString(buf, off + 345, 130);
          if (prefix) {
            this.path = prefix + "/" + this.path;
          }
          this.atime = decDate(buf, off + 476, 12);
          this.ctime = decDate(buf, off + 488, 12);
        }
      }
      let sum = 8 * 32;
      for (let i = off;i < off + 148; i++) {
        sum += buf[i];
      }
      for (let i = off + 156;i < off + 512; i++) {
        sum += buf[i];
      }
      this.cksumValid = sum === this.cksum;
      if (this.cksum === null && sum === 8 * 32) {
        this.nullBlock = true;
      }
    }
    [SLURP](ex, global2) {
      for (const k in ex) {
        if (ex[k] !== null && ex[k] !== undefined && !(global2 && k === "path")) {
          this[k] = ex[k];
        }
      }
    }
    encode(buf, off) {
      if (!buf) {
        buf = this.block = Buffer.alloc(512);
        off = 0;
      }
      if (!off) {
        off = 0;
      }
      if (!(buf.length >= off + 512)) {
        throw new Error("need 512 bytes for header");
      }
      const prefixSize = this.ctime || this.atime ? 130 : 155;
      const split = splitPrefix(this.path || "", prefixSize);
      const path = split[0];
      const prefix = split[1];
      this.needPax = split[2];
      this.needPax = encString(buf, off, 100, path) || this.needPax;
      this.needPax = encNumber(buf, off + 100, 8, this.mode) || this.needPax;
      this.needPax = encNumber(buf, off + 108, 8, this.uid) || this.needPax;
      this.needPax = encNumber(buf, off + 116, 8, this.gid) || this.needPax;
      this.needPax = encNumber(buf, off + 124, 12, this.size) || this.needPax;
      this.needPax = encDate(buf, off + 136, 12, this.mtime) || this.needPax;
      buf[off + 156] = this[TYPE].charCodeAt(0);
      this.needPax = encString(buf, off + 157, 100, this.linkpath) || this.needPax;
      buf.write("ustar\x0000", off + 257, 8);
      this.needPax = encString(buf, off + 265, 32, this.uname) || this.needPax;
      this.needPax = encString(buf, off + 297, 32, this.gname) || this.needPax;
      this.needPax = encNumber(buf, off + 329, 8, this.devmaj) || this.needPax;
      this.needPax = encNumber(buf, off + 337, 8, this.devmin) || this.needPax;
      this.needPax = encString(buf, off + 345, prefixSize, prefix) || this.needPax;
      if (buf[off + 475] !== 0) {
        this.needPax = encString(buf, off + 345, 155, prefix) || this.needPax;
      } else {
        this.needPax = encString(buf, off + 345, 130, prefix) || this.needPax;
        this.needPax = encDate(buf, off + 476, 12, this.atime) || this.needPax;
        this.needPax = encDate(buf, off + 488, 12, this.ctime) || this.needPax;
      }
      let sum = 8 * 32;
      for (let i = off;i < off + 148; i++) {
        sum += buf[i];
      }
      for (let i = off + 156;i < off + 512; i++) {
        sum += buf[i];
      }
      this.cksum = sum;
      encNumber(buf, off + 148, 8, this.cksum);
      this.cksumValid = true;
      return this.needPax;
    }
    set(data) {
      for (const i in data) {
        if (data[i] !== null && data[i] !== undefined) {
          this[i] = data[i];
        }
      }
    }
    get type() {
      return types.name.get(this[TYPE]) || this[TYPE];
    }
    get typeKey() {
      return this[TYPE];
    }
    set type(type) {
      if (types.code.has(type)) {
        this[TYPE] = types.code.get(type);
      } else {
        this[TYPE] = type;
      }
    }
  }
  var splitPrefix = (p, prefixSize) => {
    const pathSize = 100;
    let pp = p;
    let prefix = "";
    let ret;
    const root = pathModule.parse(p).root || ".";
    if (Buffer.byteLength(pp) < pathSize) {
      ret = [pp, prefix, false];
    } else {
      prefix = pathModule.dirname(pp);
      pp = pathModule.basename(pp);
      do {
        if (Buffer.byteLength(pp) <= pathSize && Buffer.byteLength(prefix) <= prefixSize) {
          ret = [pp, prefix, false];
        } else if (Buffer.byteLength(pp) > pathSize && Buffer.byteLength(prefix) <= prefixSize) {
          ret = [pp.slice(0, pathSize - 1), prefix, true];
        } else {
          pp = pathModule.join(pathModule.basename(prefix), pp);
          prefix = pathModule.dirname(prefix);
        }
      } while (prefix !== root && !ret);
      if (!ret) {
        ret = [p.slice(0, pathSize - 1), "", true];
      }
    }
    return ret;
  };
  var decString = (buf, off, size) => buf.slice(off, off + size).toString("utf8").replace(/\0.*/, "");
  var decDate = (buf, off, size) => numToDate(decNumber(buf, off, size));
  var numToDate = (num) => num === null ? null : new Date(num * 1000);
  var decNumber = (buf, off, size) => buf[off] & 128 ? large.parse(buf.slice(off, off + size)) : decSmallNumber(buf, off, size);
  var nanNull = (value) => isNaN(value) ? null : value;
  var decSmallNumber = (buf, off, size) => nanNull(parseInt(buf.slice(off, off + size).toString("utf8").replace(/\0.*$/, "").trim(), 8));
  var MAXNUM = {
    12: 8589934591,
    8: 2097151
  };
  var encNumber = (buf, off, size, number) => number === null ? false : number > MAXNUM[size] || number < 0 ? (large.encode(number, buf.slice(off, off + size)), true) : (encSmallNumber(buf, off, size, number), false);
  var encSmallNumber = (buf, off, size, number) => buf.write(octalString(number, size), off, size, "ascii");
  var octalString = (number, size) => padOctal(Math.floor(number).toString(8), size);
  var padOctal = (string, size) => (string.length === size - 1 ? string : new Array(size - string.length - 1).join("0") + string + " ") + "\x00";
  var encDate = (buf, off, size, date) => date === null ? false : encNumber(buf, off, size, date.getTime() / 1000);
  var NULLS = new Array(156).join("\x00");
  var encString = (buf, off, size, string) => string === null ? false : (buf.write(string + NULLS, off, size, "utf8"), string.length !== Buffer.byteLength(string) || string.length > size);
  module.exports = Header;
});

// ../../node_modules/tar/lib/pax.js
var require_pax = __commonJS((exports, module) => {
  var Header = require_header();
  var path = __require("path");

  class Pax {
    constructor(obj, global2) {
      this.atime = obj.atime || null;
      this.charset = obj.charset || null;
      this.comment = obj.comment || null;
      this.ctime = obj.ctime || null;
      this.gid = obj.gid || null;
      this.gname = obj.gname || null;
      this.linkpath = obj.linkpath || null;
      this.mtime = obj.mtime || null;
      this.path = obj.path || null;
      this.size = obj.size || null;
      this.uid = obj.uid || null;
      this.uname = obj.uname || null;
      this.dev = obj.dev || null;
      this.ino = obj.ino || null;
      this.nlink = obj.nlink || null;
      this.global = global2 || false;
    }
    encode() {
      const body = this.encodeBody();
      if (body === "") {
        return null;
      }
      const bodyLen = Buffer.byteLength(body);
      const bufLen = 512 * Math.ceil(1 + bodyLen / 512);
      const buf = Buffer.allocUnsafe(bufLen);
      for (let i = 0;i < 512; i++) {
        buf[i] = 0;
      }
      new Header({
        path: ("PaxHeader/" + path.basename(this.path)).slice(0, 99),
        mode: this.mode || 420,
        uid: this.uid || null,
        gid: this.gid || null,
        size: bodyLen,
        mtime: this.mtime || null,
        type: this.global ? "GlobalExtendedHeader" : "ExtendedHeader",
        linkpath: "",
        uname: this.uname || "",
        gname: this.gname || "",
        devmaj: 0,
        devmin: 0,
        atime: this.atime || null,
        ctime: this.ctime || null
      }).encode(buf);
      buf.write(body, 512, bodyLen, "utf8");
      for (let i = bodyLen + 512;i < buf.length; i++) {
        buf[i] = 0;
      }
      return buf;
    }
    encodeBody() {
      return this.encodeField("path") + this.encodeField("ctime") + this.encodeField("atime") + this.encodeField("dev") + this.encodeField("ino") + this.encodeField("nlink") + this.encodeField("charset") + this.encodeField("comment") + this.encodeField("gid") + this.encodeField("gname") + this.encodeField("linkpath") + this.encodeField("mtime") + this.encodeField("size") + this.encodeField("uid") + this.encodeField("uname");
    }
    encodeField(field) {
      if (this[field] === null || this[field] === undefined) {
        return "";
      }
      const v = this[field] instanceof Date ? this[field].getTime() / 1000 : this[field];
      const s = " " + (field === "dev" || field === "ino" || field === "nlink" ? "SCHILY." : "") + field + "=" + v + `
`;
      const byteLen = Buffer.byteLength(s);
      let digits = Math.floor(Math.log(byteLen) / Math.log(10)) + 1;
      if (byteLen + digits >= Math.pow(10, digits)) {
        digits += 1;
      }
      const len = digits + byteLen;
      return len + s;
    }
  }
  Pax.parse = (string, ex, g) => new Pax(merge(parseKV(string), ex), g);
  var merge = (a, b) => b ? Object.keys(a).reduce((s, k) => (s[k] = a[k], s), b) : a;
  var parseKV = (string) => string.replace(/\n$/, "").split(`
`).reduce(parseKVLine, Object.create(null));
  var parseKVLine = (set, line) => {
    const n = parseInt(line, 10);
    if (n !== Buffer.byteLength(line) + 1) {
      return set;
    }
    line = line.slice((n + " ").length);
    const kv = line.split("=");
    const k = kv.shift().replace(/^SCHILY\.(dev|ino|nlink)/, "$1");
    if (!k) {
      return set;
    }
    const v = kv.join("=");
    set[k] = /^([A-Z]+\.)?([mac]|birth|creation)time$/.test(k) ? new Date(v * 1000) : /^[0-9]+$/.test(v) ? +v : v;
    return set;
  };
  module.exports = Pax;
});

// ../../node_modules/tar/lib/strip-trailing-slashes.js
var require_strip_trailing_slashes = __commonJS((exports, module) => {
  module.exports = (str) => {
    let i = str.length - 1;
    let slashesStart = -1;
    while (i > -1 && str.charAt(i) === "/") {
      slashesStart = i;
      i--;
    }
    return slashesStart === -1 ? str : str.slice(0, slashesStart);
  };
});

// ../../node_modules/tar/lib/warn-mixin.js
var require_warn_mixin = __commonJS((exports, module) => {
  module.exports = (Base) => class extends Base {
    warn(code, message, data = {}) {
      if (this.file) {
        data.file = this.file;
      }
      if (this.cwd) {
        data.cwd = this.cwd;
      }
      data.code = message instanceof Error && message.code || code;
      data.tarCode = code;
      if (!this.strict && data.recoverable !== false) {
        if (message instanceof Error) {
          data = Object.assign(message, data);
          message = message.message;
        }
        this.emit("warn", data.tarCode, message, data);
      } else if (message instanceof Error) {
        this.emit("error", Object.assign(message, data));
      } else {
        this.emit("error", Object.assign(new Error(`${code}: ${message}`), data));
      }
    }
  };
});

// ../../node_modules/tar/lib/winchars.js
var require_winchars = __commonJS((exports, module) => {
  var raw = [
    "|",
    "<",
    ">",
    "?",
    ":"
  ];
  var win = raw.map((char) => String.fromCharCode(61440 + char.charCodeAt(0)));
  var toWin = new Map(raw.map((char, i) => [char, win[i]]));
  var toRaw = new Map(win.map((char, i) => [char, raw[i]]));
  module.exports = {
    encode: (s) => raw.reduce((s2, c) => s2.split(c).join(toWin.get(c)), s),
    decode: (s) => win.reduce((s2, c) => s2.split(c).join(toRaw.get(c)), s)
  };
});

// ../../node_modules/tar/lib/strip-absolute-path.js
var require_strip_absolute_path = __commonJS((exports, module) => {
  var { isAbsolute, parse } = __require("path").win32;
  module.exports = (path) => {
    let r = "";
    let parsed = parse(path);
    while (isAbsolute(path) || parsed.root) {
      const root = path.charAt(0) === "/" && path.slice(0, 4) !== "//?/" ? "/" : parsed.root;
      path = path.slice(root.length);
      r += root;
      parsed = parse(path);
    }
    return [r, path];
  };
});

// ../../node_modules/tar/lib/mode-fix.js
var require_mode_fix = __commonJS((exports, module) => {
  module.exports = (mode, isDir, portable) => {
    mode &= 4095;
    if (portable) {
      mode = (mode | 384) & ~18;
    }
    if (isDir) {
      if (mode & 256) {
        mode |= 64;
      }
      if (mode & 32) {
        mode |= 8;
      }
      if (mode & 4) {
        mode |= 1;
      }
    }
    return mode;
  };
});

// ../../node_modules/tar/lib/write-entry.js
var require_write_entry = __commonJS((exports, module) => {
  var { Minipass } = require_minipass();
  var Pax = require_pax();
  var Header = require_header();
  var fs = __require("fs");
  var path = __require("path");
  var normPath = require_normalize_windows_path();
  var stripSlash = require_strip_trailing_slashes();
  var prefixPath = (path2, prefix) => {
    if (!prefix) {
      return normPath(path2);
    }
    path2 = normPath(path2).replace(/^\.(\/|$)/, "");
    return stripSlash(prefix) + "/" + path2;
  };
  var maxReadSize = 16 * 1024 * 1024;
  var PROCESS = Symbol("process");
  var FILE = Symbol("file");
  var DIRECTORY = Symbol("directory");
  var SYMLINK = Symbol("symlink");
  var HARDLINK = Symbol("hardlink");
  var HEADER = Symbol("header");
  var READ = Symbol("read");
  var LSTAT = Symbol("lstat");
  var ONLSTAT = Symbol("onlstat");
  var ONREAD = Symbol("onread");
  var ONREADLINK = Symbol("onreadlink");
  var OPENFILE = Symbol("openfile");
  var ONOPENFILE = Symbol("onopenfile");
  var CLOSE = Symbol("close");
  var MODE = Symbol("mode");
  var AWAITDRAIN = Symbol("awaitDrain");
  var ONDRAIN = Symbol("ondrain");
  var PREFIX = Symbol("prefix");
  var HAD_ERROR = Symbol("hadError");
  var warner = require_warn_mixin();
  var winchars = require_winchars();
  var stripAbsolutePath = require_strip_absolute_path();
  var modeFix = require_mode_fix();
  var WriteEntry = warner(class WriteEntry2 extends Minipass {
    constructor(p, opt) {
      opt = opt || {};
      super(opt);
      if (typeof p !== "string") {
        throw new TypeError("path is required");
      }
      this.path = normPath(p);
      this.portable = !!opt.portable;
      this.myuid = process.getuid && process.getuid() || 0;
      this.myuser = process.env.USER || "";
      this.maxReadSize = opt.maxReadSize || maxReadSize;
      this.linkCache = opt.linkCache || new Map;
      this.statCache = opt.statCache || new Map;
      this.preservePaths = !!opt.preservePaths;
      this.cwd = normPath(opt.cwd || process.cwd());
      this.strict = !!opt.strict;
      this.noPax = !!opt.noPax;
      this.noMtime = !!opt.noMtime;
      this.mtime = opt.mtime || null;
      this.prefix = opt.prefix ? normPath(opt.prefix) : null;
      this.fd = null;
      this.blockLen = null;
      this.blockRemain = null;
      this.buf = null;
      this.offset = null;
      this.length = null;
      this.pos = null;
      this.remain = null;
      if (typeof opt.onwarn === "function") {
        this.on("warn", opt.onwarn);
      }
      let pathWarn = false;
      if (!this.preservePaths) {
        const [root, stripped] = stripAbsolutePath(this.path);
        if (root) {
          this.path = stripped;
          pathWarn = root;
        }
      }
      this.win32 = !!opt.win32 || process.platform === "win32";
      if (this.win32) {
        this.path = winchars.decode(this.path.replace(/\\/g, "/"));
        p = p.replace(/\\/g, "/");
      }
      this.absolute = normPath(opt.absolute || path.resolve(this.cwd, p));
      if (this.path === "") {
        this.path = "./";
      }
      if (pathWarn) {
        this.warn("TAR_ENTRY_INFO", `stripping ${pathWarn} from absolute path`, {
          entry: this,
          path: pathWarn + this.path
        });
      }
      if (this.statCache.has(this.absolute)) {
        this[ONLSTAT](this.statCache.get(this.absolute));
      } else {
        this[LSTAT]();
      }
    }
    emit(ev, ...data) {
      if (ev === "error") {
        this[HAD_ERROR] = true;
      }
      return super.emit(ev, ...data);
    }
    [LSTAT]() {
      fs.lstat(this.absolute, (er, stat) => {
        if (er) {
          return this.emit("error", er);
        }
        this[ONLSTAT](stat);
      });
    }
    [ONLSTAT](stat) {
      this.statCache.set(this.absolute, stat);
      this.stat = stat;
      if (!stat.isFile()) {
        stat.size = 0;
      }
      this.type = getType(stat);
      this.emit("stat", stat);
      this[PROCESS]();
    }
    [PROCESS]() {
      switch (this.type) {
        case "File":
          return this[FILE]();
        case "Directory":
          return this[DIRECTORY]();
        case "SymbolicLink":
          return this[SYMLINK]();
        default:
          return this.end();
      }
    }
    [MODE](mode) {
      return modeFix(mode, this.type === "Directory", this.portable);
    }
    [PREFIX](path2) {
      return prefixPath(path2, this.prefix);
    }
    [HEADER]() {
      if (this.type === "Directory" && this.portable) {
        this.noMtime = true;
      }
      this.header = new Header({
        path: this[PREFIX](this.path),
        linkpath: this.type === "Link" ? this[PREFIX](this.linkpath) : this.linkpath,
        mode: this[MODE](this.stat.mode),
        uid: this.portable ? null : this.stat.uid,
        gid: this.portable ? null : this.stat.gid,
        size: this.stat.size,
        mtime: this.noMtime ? null : this.mtime || this.stat.mtime,
        type: this.type,
        uname: this.portable ? null : this.stat.uid === this.myuid ? this.myuser : "",
        atime: this.portable ? null : this.stat.atime,
        ctime: this.portable ? null : this.stat.ctime
      });
      if (this.header.encode() && !this.noPax) {
        super.write(new Pax({
          atime: this.portable ? null : this.header.atime,
          ctime: this.portable ? null : this.header.ctime,
          gid: this.portable ? null : this.header.gid,
          mtime: this.noMtime ? null : this.mtime || this.header.mtime,
          path: this[PREFIX](this.path),
          linkpath: this.type === "Link" ? this[PREFIX](this.linkpath) : this.linkpath,
          size: this.header.size,
          uid: this.portable ? null : this.header.uid,
          uname: this.portable ? null : this.header.uname,
          dev: this.portable ? null : this.stat.dev,
          ino: this.portable ? null : this.stat.ino,
          nlink: this.portable ? null : this.stat.nlink
        }).encode());
      }
      super.write(this.header.block);
    }
    [DIRECTORY]() {
      if (this.path.slice(-1) !== "/") {
        this.path += "/";
      }
      this.stat.size = 0;
      this[HEADER]();
      this.end();
    }
    [SYMLINK]() {
      fs.readlink(this.absolute, (er, linkpath) => {
        if (er) {
          return this.emit("error", er);
        }
        this[ONREADLINK](linkpath);
      });
    }
    [ONREADLINK](linkpath) {
      this.linkpath = normPath(linkpath);
      this[HEADER]();
      this.end();
    }
    [HARDLINK](linkpath) {
      this.type = "Link";
      this.linkpath = normPath(path.relative(this.cwd, linkpath));
      this.stat.size = 0;
      this[HEADER]();
      this.end();
    }
    [FILE]() {
      if (this.stat.nlink > 1) {
        const linkKey = this.stat.dev + ":" + this.stat.ino;
        if (this.linkCache.has(linkKey)) {
          const linkpath = this.linkCache.get(linkKey);
          if (linkpath.indexOf(this.cwd) === 0) {
            return this[HARDLINK](linkpath);
          }
        }
        this.linkCache.set(linkKey, this.absolute);
      }
      this[HEADER]();
      if (this.stat.size === 0) {
        return this.end();
      }
      this[OPENFILE]();
    }
    [OPENFILE]() {
      fs.open(this.absolute, "r", (er, fd) => {
        if (er) {
          return this.emit("error", er);
        }
        this[ONOPENFILE](fd);
      });
    }
    [ONOPENFILE](fd) {
      this.fd = fd;
      if (this[HAD_ERROR]) {
        return this[CLOSE]();
      }
      this.blockLen = 512 * Math.ceil(this.stat.size / 512);
      this.blockRemain = this.blockLen;
      const bufLen = Math.min(this.blockLen, this.maxReadSize);
      this.buf = Buffer.allocUnsafe(bufLen);
      this.offset = 0;
      this.pos = 0;
      this.remain = this.stat.size;
      this.length = this.buf.length;
      this[READ]();
    }
    [READ]() {
      const { fd, buf, offset, length, pos } = this;
      fs.read(fd, buf, offset, length, pos, (er, bytesRead) => {
        if (er) {
          return this[CLOSE](() => this.emit("error", er));
        }
        this[ONREAD](bytesRead);
      });
    }
    [CLOSE](cb) {
      fs.close(this.fd, cb);
    }
    [ONREAD](bytesRead) {
      if (bytesRead <= 0 && this.remain > 0) {
        const er = new Error("encountered unexpected EOF");
        er.path = this.absolute;
        er.syscall = "read";
        er.code = "EOF";
        return this[CLOSE](() => this.emit("error", er));
      }
      if (bytesRead > this.remain) {
        const er = new Error("did not encounter expected EOF");
        er.path = this.absolute;
        er.syscall = "read";
        er.code = "EOF";
        return this[CLOSE](() => this.emit("error", er));
      }
      if (bytesRead === this.remain) {
        for (let i = bytesRead;i < this.length && bytesRead < this.blockRemain; i++) {
          this.buf[i + this.offset] = 0;
          bytesRead++;
          this.remain++;
        }
      }
      const writeBuf = this.offset === 0 && bytesRead === this.buf.length ? this.buf : this.buf.slice(this.offset, this.offset + bytesRead);
      const flushed = this.write(writeBuf);
      if (!flushed) {
        this[AWAITDRAIN](() => this[ONDRAIN]());
      } else {
        this[ONDRAIN]();
      }
    }
    [AWAITDRAIN](cb) {
      this.once("drain", cb);
    }
    write(writeBuf) {
      if (this.blockRemain < writeBuf.length) {
        const er = new Error("writing more data than expected");
        er.path = this.absolute;
        return this.emit("error", er);
      }
      this.remain -= writeBuf.length;
      this.blockRemain -= writeBuf.length;
      this.pos += writeBuf.length;
      this.offset += writeBuf.length;
      return super.write(writeBuf);
    }
    [ONDRAIN]() {
      if (!this.remain) {
        if (this.blockRemain) {
          super.write(Buffer.alloc(this.blockRemain));
        }
        return this[CLOSE]((er) => er ? this.emit("error", er) : this.end());
      }
      if (this.offset >= this.length) {
        this.buf = Buffer.allocUnsafe(Math.min(this.blockRemain, this.buf.length));
        this.offset = 0;
      }
      this.length = this.buf.length - this.offset;
      this[READ]();
    }
  });

  class WriteEntrySync extends WriteEntry {
    [LSTAT]() {
      this[ONLSTAT](fs.lstatSync(this.absolute));
    }
    [SYMLINK]() {
      this[ONREADLINK](fs.readlinkSync(this.absolute));
    }
    [OPENFILE]() {
      this[ONOPENFILE](fs.openSync(this.absolute, "r"));
    }
    [READ]() {
      let threw = true;
      try {
        const { fd, buf, offset, length, pos } = this;
        const bytesRead = fs.readSync(fd, buf, offset, length, pos);
        this[ONREAD](bytesRead);
        threw = false;
      } finally {
        if (threw) {
          try {
            this[CLOSE](() => {});
          } catch (er) {}
        }
      }
    }
    [AWAITDRAIN](cb) {
      cb();
    }
    [CLOSE](cb) {
      fs.closeSync(this.fd);
      cb();
    }
  }
  var WriteEntryTar = warner(class WriteEntryTar2 extends Minipass {
    constructor(readEntry, opt) {
      opt = opt || {};
      super(opt);
      this.preservePaths = !!opt.preservePaths;
      this.portable = !!opt.portable;
      this.strict = !!opt.strict;
      this.noPax = !!opt.noPax;
      this.noMtime = !!opt.noMtime;
      this.readEntry = readEntry;
      this.type = readEntry.type;
      if (this.type === "Directory" && this.portable) {
        this.noMtime = true;
      }
      this.prefix = opt.prefix || null;
      this.path = normPath(readEntry.path);
      this.mode = this[MODE](readEntry.mode);
      this.uid = this.portable ? null : readEntry.uid;
      this.gid = this.portable ? null : readEntry.gid;
      this.uname = this.portable ? null : readEntry.uname;
      this.gname = this.portable ? null : readEntry.gname;
      this.size = readEntry.size;
      this.mtime = this.noMtime ? null : opt.mtime || readEntry.mtime;
      this.atime = this.portable ? null : readEntry.atime;
      this.ctime = this.portable ? null : readEntry.ctime;
      this.linkpath = normPath(readEntry.linkpath);
      if (typeof opt.onwarn === "function") {
        this.on("warn", opt.onwarn);
      }
      let pathWarn = false;
      if (!this.preservePaths) {
        const [root, stripped] = stripAbsolutePath(this.path);
        if (root) {
          this.path = stripped;
          pathWarn = root;
        }
      }
      this.remain = readEntry.size;
      this.blockRemain = readEntry.startBlockSize;
      this.header = new Header({
        path: this[PREFIX](this.path),
        linkpath: this.type === "Link" ? this[PREFIX](this.linkpath) : this.linkpath,
        mode: this.mode,
        uid: this.portable ? null : this.uid,
        gid: this.portable ? null : this.gid,
        size: this.size,
        mtime: this.noMtime ? null : this.mtime,
        type: this.type,
        uname: this.portable ? null : this.uname,
        atime: this.portable ? null : this.atime,
        ctime: this.portable ? null : this.ctime
      });
      if (pathWarn) {
        this.warn("TAR_ENTRY_INFO", `stripping ${pathWarn} from absolute path`, {
          entry: this,
          path: pathWarn + this.path
        });
      }
      if (this.header.encode() && !this.noPax) {
        super.write(new Pax({
          atime: this.portable ? null : this.atime,
          ctime: this.portable ? null : this.ctime,
          gid: this.portable ? null : this.gid,
          mtime: this.noMtime ? null : this.mtime,
          path: this[PREFIX](this.path),
          linkpath: this.type === "Link" ? this[PREFIX](this.linkpath) : this.linkpath,
          size: this.size,
          uid: this.portable ? null : this.uid,
          uname: this.portable ? null : this.uname,
          dev: this.portable ? null : this.readEntry.dev,
          ino: this.portable ? null : this.readEntry.ino,
          nlink: this.portable ? null : this.readEntry.nlink
        }).encode());
      }
      super.write(this.header.block);
      readEntry.pipe(this);
    }
    [PREFIX](path2) {
      return prefixPath(path2, this.prefix);
    }
    [MODE](mode) {
      return modeFix(mode, this.type === "Directory", this.portable);
    }
    write(data) {
      const writeLen = data.length;
      if (writeLen > this.blockRemain) {
        throw new Error("writing more to entry than is appropriate");
      }
      this.blockRemain -= writeLen;
      return super.write(data);
    }
    end() {
      if (this.blockRemain) {
        super.write(Buffer.alloc(this.blockRemain));
      }
      return super.end();
    }
  });
  WriteEntry.Sync = WriteEntrySync;
  WriteEntry.Tar = WriteEntryTar;
  var getType = (stat) => stat.isFile() ? "File" : stat.isDirectory() ? "Directory" : stat.isSymbolicLink() ? "SymbolicLink" : "Unsupported";
  module.exports = WriteEntry;
});

// ../../node_modules/yallist/iterator.js
var require_iterator = __commonJS((exports, module) => {
  module.exports = function(Yallist) {
    Yallist.prototype[Symbol.iterator] = function* () {
      for (let walker = this.head;walker; walker = walker.next) {
        yield walker.value;
      }
    };
  };
});

// ../../node_modules/yallist/yallist.js
var require_yallist = __commonJS((exports, module) => {
  module.exports = Yallist;
  Yallist.Node = Node;
  Yallist.create = Yallist;
  function Yallist(list) {
    var self = this;
    if (!(self instanceof Yallist)) {
      self = new Yallist;
    }
    self.tail = null;
    self.head = null;
    self.length = 0;
    if (list && typeof list.forEach === "function") {
      list.forEach(function(item) {
        self.push(item);
      });
    } else if (arguments.length > 0) {
      for (var i = 0, l = arguments.length;i < l; i++) {
        self.push(arguments[i]);
      }
    }
    return self;
  }
  Yallist.prototype.removeNode = function(node) {
    if (node.list !== this) {
      throw new Error("removing node which does not belong to this list");
    }
    var next = node.next;
    var prev = node.prev;
    if (next) {
      next.prev = prev;
    }
    if (prev) {
      prev.next = next;
    }
    if (node === this.head) {
      this.head = next;
    }
    if (node === this.tail) {
      this.tail = prev;
    }
    node.list.length--;
    node.next = null;
    node.prev = null;
    node.list = null;
    return next;
  };
  Yallist.prototype.unshiftNode = function(node) {
    if (node === this.head) {
      return;
    }
    if (node.list) {
      node.list.removeNode(node);
    }
    var head = this.head;
    node.list = this;
    node.next = head;
    if (head) {
      head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
    this.length++;
  };
  Yallist.prototype.pushNode = function(node) {
    if (node === this.tail) {
      return;
    }
    if (node.list) {
      node.list.removeNode(node);
    }
    var tail = this.tail;
    node.list = this;
    node.prev = tail;
    if (tail) {
      tail.next = node;
    }
    this.tail = node;
    if (!this.head) {
      this.head = node;
    }
    this.length++;
  };
  Yallist.prototype.push = function() {
    for (var i = 0, l = arguments.length;i < l; i++) {
      push(this, arguments[i]);
    }
    return this.length;
  };
  Yallist.prototype.unshift = function() {
    for (var i = 0, l = arguments.length;i < l; i++) {
      unshift(this, arguments[i]);
    }
    return this.length;
  };
  Yallist.prototype.pop = function() {
    if (!this.tail) {
      return;
    }
    var res = this.tail.value;
    this.tail = this.tail.prev;
    if (this.tail) {
      this.tail.next = null;
    } else {
      this.head = null;
    }
    this.length--;
    return res;
  };
  Yallist.prototype.shift = function() {
    if (!this.head) {
      return;
    }
    var res = this.head.value;
    this.head = this.head.next;
    if (this.head) {
      this.head.prev = null;
    } else {
      this.tail = null;
    }
    this.length--;
    return res;
  };
  Yallist.prototype.forEach = function(fn, thisp) {
    thisp = thisp || this;
    for (var walker = this.head, i = 0;walker !== null; i++) {
      fn.call(thisp, walker.value, i, this);
      walker = walker.next;
    }
  };
  Yallist.prototype.forEachReverse = function(fn, thisp) {
    thisp = thisp || this;
    for (var walker = this.tail, i = this.length - 1;walker !== null; i--) {
      fn.call(thisp, walker.value, i, this);
      walker = walker.prev;
    }
  };
  Yallist.prototype.get = function(n) {
    for (var i = 0, walker = this.head;walker !== null && i < n; i++) {
      walker = walker.next;
    }
    if (i === n && walker !== null) {
      return walker.value;
    }
  };
  Yallist.prototype.getReverse = function(n) {
    for (var i = 0, walker = this.tail;walker !== null && i < n; i++) {
      walker = walker.prev;
    }
    if (i === n && walker !== null) {
      return walker.value;
    }
  };
  Yallist.prototype.map = function(fn, thisp) {
    thisp = thisp || this;
    var res = new Yallist;
    for (var walker = this.head;walker !== null; ) {
      res.push(fn.call(thisp, walker.value, this));
      walker = walker.next;
    }
    return res;
  };
  Yallist.prototype.mapReverse = function(fn, thisp) {
    thisp = thisp || this;
    var res = new Yallist;
    for (var walker = this.tail;walker !== null; ) {
      res.push(fn.call(thisp, walker.value, this));
      walker = walker.prev;
    }
    return res;
  };
  Yallist.prototype.reduce = function(fn, initial) {
    var acc;
    var walker = this.head;
    if (arguments.length > 1) {
      acc = initial;
    } else if (this.head) {
      walker = this.head.next;
      acc = this.head.value;
    } else {
      throw new TypeError("Reduce of empty list with no initial value");
    }
    for (var i = 0;walker !== null; i++) {
      acc = fn(acc, walker.value, i);
      walker = walker.next;
    }
    return acc;
  };
  Yallist.prototype.reduceReverse = function(fn, initial) {
    var acc;
    var walker = this.tail;
    if (arguments.length > 1) {
      acc = initial;
    } else if (this.tail) {
      walker = this.tail.prev;
      acc = this.tail.value;
    } else {
      throw new TypeError("Reduce of empty list with no initial value");
    }
    for (var i = this.length - 1;walker !== null; i--) {
      acc = fn(acc, walker.value, i);
      walker = walker.prev;
    }
    return acc;
  };
  Yallist.prototype.toArray = function() {
    var arr = new Array(this.length);
    for (var i = 0, walker = this.head;walker !== null; i++) {
      arr[i] = walker.value;
      walker = walker.next;
    }
    return arr;
  };
  Yallist.prototype.toArrayReverse = function() {
    var arr = new Array(this.length);
    for (var i = 0, walker = this.tail;walker !== null; i++) {
      arr[i] = walker.value;
      walker = walker.prev;
    }
    return arr;
  };
  Yallist.prototype.slice = function(from, to) {
    to = to || this.length;
    if (to < 0) {
      to += this.length;
    }
    from = from || 0;
    if (from < 0) {
      from += this.length;
    }
    var ret = new Yallist;
    if (to < from || to < 0) {
      return ret;
    }
    if (from < 0) {
      from = 0;
    }
    if (to > this.length) {
      to = this.length;
    }
    for (var i = 0, walker = this.head;walker !== null && i < from; i++) {
      walker = walker.next;
    }
    for (;walker !== null && i < to; i++, walker = walker.next) {
      ret.push(walker.value);
    }
    return ret;
  };
  Yallist.prototype.sliceReverse = function(from, to) {
    to = to || this.length;
    if (to < 0) {
      to += this.length;
    }
    from = from || 0;
    if (from < 0) {
      from += this.length;
    }
    var ret = new Yallist;
    if (to < from || to < 0) {
      return ret;
    }
    if (from < 0) {
      from = 0;
    }
    if (to > this.length) {
      to = this.length;
    }
    for (var i = this.length, walker = this.tail;walker !== null && i > to; i--) {
      walker = walker.prev;
    }
    for (;walker !== null && i > from; i--, walker = walker.prev) {
      ret.push(walker.value);
    }
    return ret;
  };
  Yallist.prototype.splice = function(start, deleteCount, ...nodes) {
    if (start > this.length) {
      start = this.length - 1;
    }
    if (start < 0) {
      start = this.length + start;
    }
    for (var i = 0, walker = this.head;walker !== null && i < start; i++) {
      walker = walker.next;
    }
    var ret = [];
    for (var i = 0;walker && i < deleteCount; i++) {
      ret.push(walker.value);
      walker = this.removeNode(walker);
    }
    if (walker === null) {
      walker = this.tail;
    }
    if (walker !== this.head && walker !== this.tail) {
      walker = walker.prev;
    }
    for (var i = 0;i < nodes.length; i++) {
      walker = insert(this, walker, nodes[i]);
    }
    return ret;
  };
  Yallist.prototype.reverse = function() {
    var head = this.head;
    var tail = this.tail;
    for (var walker = head;walker !== null; walker = walker.prev) {
      var p = walker.prev;
      walker.prev = walker.next;
      walker.next = p;
    }
    this.head = tail;
    this.tail = head;
    return this;
  };
  function insert(self, node, value) {
    var inserted = node === self.head ? new Node(value, null, node, self) : new Node(value, node, node.next, self);
    if (inserted.next === null) {
      self.tail = inserted;
    }
    if (inserted.prev === null) {
      self.head = inserted;
    }
    self.length++;
    return inserted;
  }
  function push(self, item) {
    self.tail = new Node(item, self.tail, null, self);
    if (!self.head) {
      self.head = self.tail;
    }
    self.length++;
  }
  function unshift(self, item) {
    self.head = new Node(item, null, self.head, self);
    if (!self.tail) {
      self.tail = self.head;
    }
    self.length++;
  }
  function Node(value, prev, next, list) {
    if (!(this instanceof Node)) {
      return new Node(value, prev, next, list);
    }
    this.list = list;
    this.value = value;
    if (prev) {
      prev.next = this;
      this.prev = prev;
    } else {
      this.prev = null;
    }
    if (next) {
      next.prev = this;
      this.next = next;
    } else {
      this.next = null;
    }
  }
  try {
    require_iterator()(Yallist);
  } catch (er) {}
});

// ../../node_modules/tar/lib/pack.js
var require_pack = __commonJS((exports, module) => {
  class PackJob {
    constructor(path2, absolute) {
      this.path = path2 || "./";
      this.absolute = absolute;
      this.entry = null;
      this.stat = null;
      this.readdir = null;
      this.pending = false;
      this.ignore = false;
      this.piped = false;
    }
  }
  var { Minipass } = require_minipass();
  var zlib = require_minizlib();
  var ReadEntry = require_read_entry();
  var WriteEntry = require_write_entry();
  var WriteEntrySync = WriteEntry.Sync;
  var WriteEntryTar = WriteEntry.Tar;
  var Yallist = require_yallist();
  var EOF = Buffer.alloc(1024);
  var ONSTAT = Symbol("onStat");
  var ENDED = Symbol("ended");
  var QUEUE = Symbol("queue");
  var CURRENT = Symbol("current");
  var PROCESS = Symbol("process");
  var PROCESSING = Symbol("processing");
  var PROCESSJOB = Symbol("processJob");
  var JOBS = Symbol("jobs");
  var JOBDONE = Symbol("jobDone");
  var ADDFSENTRY = Symbol("addFSEntry");
  var ADDTARENTRY = Symbol("addTarEntry");
  var STAT = Symbol("stat");
  var READDIR = Symbol("readdir");
  var ONREADDIR = Symbol("onreaddir");
  var PIPE = Symbol("pipe");
  var ENTRY = Symbol("entry");
  var ENTRYOPT = Symbol("entryOpt");
  var WRITEENTRYCLASS = Symbol("writeEntryClass");
  var WRITE = Symbol("write");
  var ONDRAIN = Symbol("ondrain");
  var fs = __require("fs");
  var path = __require("path");
  var warner = require_warn_mixin();
  var normPath = require_normalize_windows_path();
  var Pack = warner(class Pack2 extends Minipass {
    constructor(opt) {
      super(opt);
      opt = opt || Object.create(null);
      this.opt = opt;
      this.file = opt.file || "";
      this.cwd = opt.cwd || process.cwd();
      this.maxReadSize = opt.maxReadSize;
      this.preservePaths = !!opt.preservePaths;
      this.strict = !!opt.strict;
      this.noPax = !!opt.noPax;
      this.prefix = normPath(opt.prefix || "");
      this.linkCache = opt.linkCache || new Map;
      this.statCache = opt.statCache || new Map;
      this.readdirCache = opt.readdirCache || new Map;
      this[WRITEENTRYCLASS] = WriteEntry;
      if (typeof opt.onwarn === "function") {
        this.on("warn", opt.onwarn);
      }
      this.portable = !!opt.portable;
      this.zip = null;
      if (opt.gzip || opt.brotli) {
        if (opt.gzip && opt.brotli) {
          throw new TypeError("gzip and brotli are mutually exclusive");
        }
        if (opt.gzip) {
          if (typeof opt.gzip !== "object") {
            opt.gzip = {};
          }
          if (this.portable) {
            opt.gzip.portable = true;
          }
          this.zip = new zlib.Gzip(opt.gzip);
        }
        if (opt.brotli) {
          if (typeof opt.brotli !== "object") {
            opt.brotli = {};
          }
          this.zip = new zlib.BrotliCompress(opt.brotli);
        }
        this.zip.on("data", (chunk) => super.write(chunk));
        this.zip.on("end", (_) => super.end());
        this.zip.on("drain", (_) => this[ONDRAIN]());
        this.on("resume", (_) => this.zip.resume());
      } else {
        this.on("drain", this[ONDRAIN]);
      }
      this.noDirRecurse = !!opt.noDirRecurse;
      this.follow = !!opt.follow;
      this.noMtime = !!opt.noMtime;
      this.mtime = opt.mtime || null;
      this.filter = typeof opt.filter === "function" ? opt.filter : (_) => true;
      this[QUEUE] = new Yallist;
      this[JOBS] = 0;
      this.jobs = +opt.jobs || 4;
      this[PROCESSING] = false;
      this[ENDED] = false;
    }
    [WRITE](chunk) {
      return super.write(chunk);
    }
    add(path2) {
      this.write(path2);
      return this;
    }
    end(path2) {
      if (path2) {
        this.write(path2);
      }
      this[ENDED] = true;
      this[PROCESS]();
      return this;
    }
    write(path2) {
      if (this[ENDED]) {
        throw new Error("write after end");
      }
      if (path2 instanceof ReadEntry) {
        this[ADDTARENTRY](path2);
      } else {
        this[ADDFSENTRY](path2);
      }
      return this.flowing;
    }
    [ADDTARENTRY](p) {
      const absolute = normPath(path.resolve(this.cwd, p.path));
      if (!this.filter(p.path, p)) {
        p.resume();
      } else {
        const job = new PackJob(p.path, absolute, false);
        job.entry = new WriteEntryTar(p, this[ENTRYOPT](job));
        job.entry.on("end", (_) => this[JOBDONE](job));
        this[JOBS] += 1;
        this[QUEUE].push(job);
      }
      this[PROCESS]();
    }
    [ADDFSENTRY](p) {
      const absolute = normPath(path.resolve(this.cwd, p));
      this[QUEUE].push(new PackJob(p, absolute));
      this[PROCESS]();
    }
    [STAT](job) {
      job.pending = true;
      this[JOBS] += 1;
      const stat = this.follow ? "stat" : "lstat";
      fs[stat](job.absolute, (er, stat2) => {
        job.pending = false;
        this[JOBS] -= 1;
        if (er) {
          this.emit("error", er);
        } else {
          this[ONSTAT](job, stat2);
        }
      });
    }
    [ONSTAT](job, stat) {
      this.statCache.set(job.absolute, stat);
      job.stat = stat;
      if (!this.filter(job.path, stat)) {
        job.ignore = true;
      }
      this[PROCESS]();
    }
    [READDIR](job) {
      job.pending = true;
      this[JOBS] += 1;
      fs.readdir(job.absolute, (er, entries) => {
        job.pending = false;
        this[JOBS] -= 1;
        if (er) {
          return this.emit("error", er);
        }
        this[ONREADDIR](job, entries);
      });
    }
    [ONREADDIR](job, entries) {
      this.readdirCache.set(job.absolute, entries);
      job.readdir = entries;
      this[PROCESS]();
    }
    [PROCESS]() {
      if (this[PROCESSING]) {
        return;
      }
      this[PROCESSING] = true;
      for (let w = this[QUEUE].head;w !== null && this[JOBS] < this.jobs; w = w.next) {
        this[PROCESSJOB](w.value);
        if (w.value.ignore) {
          const p = w.next;
          this[QUEUE].removeNode(w);
          w.next = p;
        }
      }
      this[PROCESSING] = false;
      if (this[ENDED] && !this[QUEUE].length && this[JOBS] === 0) {
        if (this.zip) {
          this.zip.end(EOF);
        } else {
          super.write(EOF);
          super.end();
        }
      }
    }
    get [CURRENT]() {
      return this[QUEUE] && this[QUEUE].head && this[QUEUE].head.value;
    }
    [JOBDONE](job) {
      this[QUEUE].shift();
      this[JOBS] -= 1;
      this[PROCESS]();
    }
    [PROCESSJOB](job) {
      if (job.pending) {
        return;
      }
      if (job.entry) {
        if (job === this[CURRENT] && !job.piped) {
          this[PIPE](job);
        }
        return;
      }
      if (!job.stat) {
        if (this.statCache.has(job.absolute)) {
          this[ONSTAT](job, this.statCache.get(job.absolute));
        } else {
          this[STAT](job);
        }
      }
      if (!job.stat) {
        return;
      }
      if (job.ignore) {
        return;
      }
      if (!this.noDirRecurse && job.stat.isDirectory() && !job.readdir) {
        if (this.readdirCache.has(job.absolute)) {
          this[ONREADDIR](job, this.readdirCache.get(job.absolute));
        } else {
          this[READDIR](job);
        }
        if (!job.readdir) {
          return;
        }
      }
      job.entry = this[ENTRY](job);
      if (!job.entry) {
        job.ignore = true;
        return;
      }
      if (job === this[CURRENT] && !job.piped) {
        this[PIPE](job);
      }
    }
    [ENTRYOPT](job) {
      return {
        onwarn: (code, msg, data) => this.warn(code, msg, data),
        noPax: this.noPax,
        cwd: this.cwd,
        absolute: job.absolute,
        preservePaths: this.preservePaths,
        maxReadSize: this.maxReadSize,
        strict: this.strict,
        portable: this.portable,
        linkCache: this.linkCache,
        statCache: this.statCache,
        noMtime: this.noMtime,
        mtime: this.mtime,
        prefix: this.prefix
      };
    }
    [ENTRY](job) {
      this[JOBS] += 1;
      try {
        return new this[WRITEENTRYCLASS](job.path, this[ENTRYOPT](job)).on("end", () => this[JOBDONE](job)).on("error", (er) => this.emit("error", er));
      } catch (er) {
        this.emit("error", er);
      }
    }
    [ONDRAIN]() {
      if (this[CURRENT] && this[CURRENT].entry) {
        this[CURRENT].entry.resume();
      }
    }
    [PIPE](job) {
      job.piped = true;
      if (job.readdir) {
        job.readdir.forEach((entry) => {
          const p = job.path;
          const base = p === "./" ? "" : p.replace(/\/*$/, "/");
          this[ADDFSENTRY](base + entry);
        });
      }
      const source = job.entry;
      const zip = this.zip;
      if (zip) {
        source.on("data", (chunk) => {
          if (!zip.write(chunk)) {
            source.pause();
          }
        });
      } else {
        source.on("data", (chunk) => {
          if (!super.write(chunk)) {
            source.pause();
          }
        });
      }
    }
    pause() {
      if (this.zip) {
        this.zip.pause();
      }
      return super.pause();
    }
  });

  class PackSync extends Pack {
    constructor(opt) {
      super(opt);
      this[WRITEENTRYCLASS] = WriteEntrySync;
    }
    pause() {}
    resume() {}
    [STAT](job) {
      const stat = this.follow ? "statSync" : "lstatSync";
      this[ONSTAT](job, fs[stat](job.absolute));
    }
    [READDIR](job, stat) {
      this[ONREADDIR](job, fs.readdirSync(job.absolute));
    }
    [PIPE](job) {
      const source = job.entry;
      const zip = this.zip;
      if (job.readdir) {
        job.readdir.forEach((entry) => {
          const p = job.path;
          const base = p === "./" ? "" : p.replace(/\/*$/, "/");
          this[ADDFSENTRY](base + entry);
        });
      }
      if (zip) {
        source.on("data", (chunk) => {
          zip.write(chunk);
        });
      } else {
        source.on("data", (chunk) => {
          super[WRITE](chunk);
        });
      }
    }
  }
  Pack.Sync = PackSync;
  module.exports = Pack;
});

// ../../node_modules/fs-minipass/node_modules/minipass/index.js
var require_minipass3 = __commonJS((exports, module) => {
  var proc = typeof process === "object" && process ? process : {
    stdout: null,
    stderr: null
  };
  var EE = __require("events");
  var Stream = __require("stream");
  var SD = __require("string_decoder").StringDecoder;
  var EOF = Symbol("EOF");
  var MAYBE_EMIT_END = Symbol("maybeEmitEnd");
  var EMITTED_END = Symbol("emittedEnd");
  var EMITTING_END = Symbol("emittingEnd");
  var EMITTED_ERROR = Symbol("emittedError");
  var CLOSED = Symbol("closed");
  var READ = Symbol("read");
  var FLUSH = Symbol("flush");
  var FLUSHCHUNK = Symbol("flushChunk");
  var ENCODING = Symbol("encoding");
  var DECODER = Symbol("decoder");
  var FLOWING = Symbol("flowing");
  var PAUSED = Symbol("paused");
  var RESUME = Symbol("resume");
  var BUFFERLENGTH = Symbol("bufferLength");
  var BUFFERPUSH = Symbol("bufferPush");
  var BUFFERSHIFT = Symbol("bufferShift");
  var OBJECTMODE = Symbol("objectMode");
  var DESTROYED = Symbol("destroyed");
  var EMITDATA = Symbol("emitData");
  var EMITEND = Symbol("emitEnd");
  var EMITEND2 = Symbol("emitEnd2");
  var ASYNC = Symbol("async");
  var defer = (fn) => Promise.resolve().then(fn);
  var doIter = global._MP_NO_ITERATOR_SYMBOLS_ !== "1";
  var ASYNCITERATOR = doIter && Symbol.asyncIterator || Symbol("asyncIterator not implemented");
  var ITERATOR = doIter && Symbol.iterator || Symbol("iterator not implemented");
  var isEndish = (ev) => ev === "end" || ev === "finish" || ev === "prefinish";
  var isArrayBuffer = (b) => b instanceof ArrayBuffer || typeof b === "object" && b.constructor && b.constructor.name === "ArrayBuffer" && b.byteLength >= 0;
  var isArrayBufferView = (b) => !Buffer.isBuffer(b) && ArrayBuffer.isView(b);

  class Pipe {
    constructor(src, dest, opts) {
      this.src = src;
      this.dest = dest;
      this.opts = opts;
      this.ondrain = () => src[RESUME]();
      dest.on("drain", this.ondrain);
    }
    unpipe() {
      this.dest.removeListener("drain", this.ondrain);
    }
    proxyErrors() {}
    end() {
      this.unpipe();
      if (this.opts.end)
        this.dest.end();
    }
  }

  class PipeProxyErrors extends Pipe {
    unpipe() {
      this.src.removeListener("error", this.proxyErrors);
      super.unpipe();
    }
    constructor(src, dest, opts) {
      super(src, dest, opts);
      this.proxyErrors = (er) => dest.emit("error", er);
      src.on("error", this.proxyErrors);
    }
  }
  module.exports = class Minipass extends Stream {
    constructor(options) {
      super();
      this[FLOWING] = false;
      this[PAUSED] = false;
      this.pipes = [];
      this.buffer = [];
      this[OBJECTMODE] = options && options.objectMode || false;
      if (this[OBJECTMODE])
        this[ENCODING] = null;
      else
        this[ENCODING] = options && options.encoding || null;
      if (this[ENCODING] === "buffer")
        this[ENCODING] = null;
      this[ASYNC] = options && !!options.async || false;
      this[DECODER] = this[ENCODING] ? new SD(this[ENCODING]) : null;
      this[EOF] = false;
      this[EMITTED_END] = false;
      this[EMITTING_END] = false;
      this[CLOSED] = false;
      this[EMITTED_ERROR] = null;
      this.writable = true;
      this.readable = true;
      this[BUFFERLENGTH] = 0;
      this[DESTROYED] = false;
    }
    get bufferLength() {
      return this[BUFFERLENGTH];
    }
    get encoding() {
      return this[ENCODING];
    }
    set encoding(enc) {
      if (this[OBJECTMODE])
        throw new Error("cannot set encoding in objectMode");
      if (this[ENCODING] && enc !== this[ENCODING] && (this[DECODER] && this[DECODER].lastNeed || this[BUFFERLENGTH]))
        throw new Error("cannot change encoding");
      if (this[ENCODING] !== enc) {
        this[DECODER] = enc ? new SD(enc) : null;
        if (this.buffer.length)
          this.buffer = this.buffer.map((chunk) => this[DECODER].write(chunk));
      }
      this[ENCODING] = enc;
    }
    setEncoding(enc) {
      this.encoding = enc;
    }
    get objectMode() {
      return this[OBJECTMODE];
    }
    set objectMode(om) {
      this[OBJECTMODE] = this[OBJECTMODE] || !!om;
    }
    get ["async"]() {
      return this[ASYNC];
    }
    set ["async"](a) {
      this[ASYNC] = this[ASYNC] || !!a;
    }
    write(chunk, encoding, cb) {
      if (this[EOF])
        throw new Error("write after end");
      if (this[DESTROYED]) {
        this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }));
        return true;
      }
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (!encoding)
        encoding = "utf8";
      const fn = this[ASYNC] ? defer : (f) => f();
      if (!this[OBJECTMODE] && !Buffer.isBuffer(chunk)) {
        if (isArrayBufferView(chunk))
          chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        else if (isArrayBuffer(chunk))
          chunk = Buffer.from(chunk);
        else if (typeof chunk !== "string")
          this.objectMode = true;
      }
      if (this[OBJECTMODE]) {
        if (this.flowing && this[BUFFERLENGTH] !== 0)
          this[FLUSH](true);
        if (this.flowing)
          this.emit("data", chunk);
        else
          this[BUFFERPUSH](chunk);
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (!chunk.length) {
        if (this[BUFFERLENGTH] !== 0)
          this.emit("readable");
        if (cb)
          fn(cb);
        return this.flowing;
      }
      if (typeof chunk === "string" && !(encoding === this[ENCODING] && !this[DECODER].lastNeed)) {
        chunk = Buffer.from(chunk, encoding);
      }
      if (Buffer.isBuffer(chunk) && this[ENCODING])
        chunk = this[DECODER].write(chunk);
      if (this.flowing && this[BUFFERLENGTH] !== 0)
        this[FLUSH](true);
      if (this.flowing)
        this.emit("data", chunk);
      else
        this[BUFFERPUSH](chunk);
      if (this[BUFFERLENGTH] !== 0)
        this.emit("readable");
      if (cb)
        fn(cb);
      return this.flowing;
    }
    read(n) {
      if (this[DESTROYED])
        return null;
      if (this[BUFFERLENGTH] === 0 || n === 0 || n > this[BUFFERLENGTH]) {
        this[MAYBE_EMIT_END]();
        return null;
      }
      if (this[OBJECTMODE])
        n = null;
      if (this.buffer.length > 1 && !this[OBJECTMODE]) {
        if (this.encoding)
          this.buffer = [this.buffer.join("")];
        else
          this.buffer = [Buffer.concat(this.buffer, this[BUFFERLENGTH])];
      }
      const ret = this[READ](n || null, this.buffer[0]);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [READ](n, chunk) {
      if (n === chunk.length || n === null)
        this[BUFFERSHIFT]();
      else {
        this.buffer[0] = chunk.slice(n);
        chunk = chunk.slice(0, n);
        this[BUFFERLENGTH] -= n;
      }
      this.emit("data", chunk);
      if (!this.buffer.length && !this[EOF])
        this.emit("drain");
      return chunk;
    }
    end(chunk, encoding, cb) {
      if (typeof chunk === "function")
        cb = chunk, chunk = null;
      if (typeof encoding === "function")
        cb = encoding, encoding = "utf8";
      if (chunk)
        this.write(chunk, encoding);
      if (cb)
        this.once("end", cb);
      this[EOF] = true;
      this.writable = false;
      if (this.flowing || !this[PAUSED])
        this[MAYBE_EMIT_END]();
      return this;
    }
    [RESUME]() {
      if (this[DESTROYED])
        return;
      this[PAUSED] = false;
      this[FLOWING] = true;
      this.emit("resume");
      if (this.buffer.length)
        this[FLUSH]();
      else if (this[EOF])
        this[MAYBE_EMIT_END]();
      else
        this.emit("drain");
    }
    resume() {
      return this[RESUME]();
    }
    pause() {
      this[FLOWING] = false;
      this[PAUSED] = true;
    }
    get destroyed() {
      return this[DESTROYED];
    }
    get flowing() {
      return this[FLOWING];
    }
    get paused() {
      return this[PAUSED];
    }
    [BUFFERPUSH](chunk) {
      if (this[OBJECTMODE])
        this[BUFFERLENGTH] += 1;
      else
        this[BUFFERLENGTH] += chunk.length;
      this.buffer.push(chunk);
    }
    [BUFFERSHIFT]() {
      if (this.buffer.length) {
        if (this[OBJECTMODE])
          this[BUFFERLENGTH] -= 1;
        else
          this[BUFFERLENGTH] -= this.buffer[0].length;
      }
      return this.buffer.shift();
    }
    [FLUSH](noDrain) {
      do {} while (this[FLUSHCHUNK](this[BUFFERSHIFT]()));
      if (!noDrain && !this.buffer.length && !this[EOF])
        this.emit("drain");
    }
    [FLUSHCHUNK](chunk) {
      return chunk ? (this.emit("data", chunk), this.flowing) : false;
    }
    pipe(dest, opts) {
      if (this[DESTROYED])
        return;
      const ended = this[EMITTED_END];
      opts = opts || {};
      if (dest === proc.stdout || dest === proc.stderr)
        opts.end = false;
      else
        opts.end = opts.end !== false;
      opts.proxyErrors = !!opts.proxyErrors;
      if (ended) {
        if (opts.end)
          dest.end();
      } else {
        this.pipes.push(!opts.proxyErrors ? new Pipe(this, dest, opts) : new PipeProxyErrors(this, dest, opts));
        if (this[ASYNC])
          defer(() => this[RESUME]());
        else
          this[RESUME]();
      }
      return dest;
    }
    unpipe(dest) {
      const p = this.pipes.find((p2) => p2.dest === dest);
      if (p) {
        this.pipes.splice(this.pipes.indexOf(p), 1);
        p.unpipe();
      }
    }
    addListener(ev, fn) {
      return this.on(ev, fn);
    }
    on(ev, fn) {
      const ret = super.on(ev, fn);
      if (ev === "data" && !this.pipes.length && !this.flowing)
        this[RESUME]();
      else if (ev === "readable" && this[BUFFERLENGTH] !== 0)
        super.emit("readable");
      else if (isEndish(ev) && this[EMITTED_END]) {
        super.emit(ev);
        this.removeAllListeners(ev);
      } else if (ev === "error" && this[EMITTED_ERROR]) {
        if (this[ASYNC])
          defer(() => fn.call(this, this[EMITTED_ERROR]));
        else
          fn.call(this, this[EMITTED_ERROR]);
      }
      return ret;
    }
    get emittedEnd() {
      return this[EMITTED_END];
    }
    [MAYBE_EMIT_END]() {
      if (!this[EMITTING_END] && !this[EMITTED_END] && !this[DESTROYED] && this.buffer.length === 0 && this[EOF]) {
        this[EMITTING_END] = true;
        this.emit("end");
        this.emit("prefinish");
        this.emit("finish");
        if (this[CLOSED])
          this.emit("close");
        this[EMITTING_END] = false;
      }
    }
    emit(ev, data, ...extra) {
      if (ev !== "error" && ev !== "close" && ev !== DESTROYED && this[DESTROYED])
        return;
      else if (ev === "data") {
        return !data ? false : this[ASYNC] ? defer(() => this[EMITDATA](data)) : this[EMITDATA](data);
      } else if (ev === "end") {
        return this[EMITEND]();
      } else if (ev === "close") {
        this[CLOSED] = true;
        if (!this[EMITTED_END] && !this[DESTROYED])
          return;
        const ret2 = super.emit("close");
        this.removeAllListeners("close");
        return ret2;
      } else if (ev === "error") {
        this[EMITTED_ERROR] = data;
        const ret2 = super.emit("error", data);
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "resume") {
        const ret2 = super.emit("resume");
        this[MAYBE_EMIT_END]();
        return ret2;
      } else if (ev === "finish" || ev === "prefinish") {
        const ret2 = super.emit(ev);
        this.removeAllListeners(ev);
        return ret2;
      }
      const ret = super.emit(ev, data, ...extra);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITDATA](data) {
      for (const p of this.pipes) {
        if (p.dest.write(data) === false)
          this.pause();
      }
      const ret = super.emit("data", data);
      this[MAYBE_EMIT_END]();
      return ret;
    }
    [EMITEND]() {
      if (this[EMITTED_END])
        return;
      this[EMITTED_END] = true;
      this.readable = false;
      if (this[ASYNC])
        defer(() => this[EMITEND2]());
      else
        this[EMITEND2]();
    }
    [EMITEND2]() {
      if (this[DECODER]) {
        const data = this[DECODER].end();
        if (data) {
          for (const p of this.pipes) {
            p.dest.write(data);
          }
          super.emit("data", data);
        }
      }
      for (const p of this.pipes) {
        p.end();
      }
      const ret = super.emit("end");
      this.removeAllListeners("end");
      return ret;
    }
    collect() {
      const buf = [];
      if (!this[OBJECTMODE])
        buf.dataLength = 0;
      const p = this.promise();
      this.on("data", (c) => {
        buf.push(c);
        if (!this[OBJECTMODE])
          buf.dataLength += c.length;
      });
      return p.then(() => buf);
    }
    concat() {
      return this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this.collect().then((buf) => this[OBJECTMODE] ? Promise.reject(new Error("cannot concat in objectMode")) : this[ENCODING] ? buf.join("") : Buffer.concat(buf, buf.dataLength));
    }
    promise() {
      return new Promise((resolve, reject) => {
        this.on(DESTROYED, () => reject(new Error("stream destroyed")));
        this.on("error", (er) => reject(er));
        this.on("end", () => resolve());
      });
    }
    [ASYNCITERATOR]() {
      const next = () => {
        const res = this.read();
        if (res !== null)
          return Promise.resolve({ done: false, value: res });
        if (this[EOF])
          return Promise.resolve({ done: true });
        let resolve = null;
        let reject = null;
        const onerr = (er) => {
          this.removeListener("data", ondata);
          this.removeListener("end", onend);
          reject(er);
        };
        const ondata = (value) => {
          this.removeListener("error", onerr);
          this.removeListener("end", onend);
          this.pause();
          resolve({ value, done: !!this[EOF] });
        };
        const onend = () => {
          this.removeListener("error", onerr);
          this.removeListener("data", ondata);
          resolve({ done: true });
        };
        const ondestroy = () => onerr(new Error("stream destroyed"));
        return new Promise((res2, rej) => {
          reject = rej;
          resolve = res2;
          this.once(DESTROYED, ondestroy);
          this.once("error", onerr);
          this.once("end", onend);
          this.once("data", ondata);
        });
      };
      return { next };
    }
    [ITERATOR]() {
      const next = () => {
        const value = this.read();
        const done = value === null;
        return { value, done };
      };
      return { next };
    }
    destroy(er) {
      if (this[DESTROYED]) {
        if (er)
          this.emit("error", er);
        else
          this.emit(DESTROYED);
        return this;
      }
      this[DESTROYED] = true;
      this.buffer.length = 0;
      this[BUFFERLENGTH] = 0;
      if (typeof this.close === "function" && !this[CLOSED])
        this.close();
      if (er)
        this.emit("error", er);
      else
        this.emit(DESTROYED);
      return this;
    }
    static isStream(s) {
      return !!s && (s instanceof Minipass || s instanceof Stream || s instanceof EE && (typeof s.pipe === "function" || typeof s.write === "function" && typeof s.end === "function"));
    }
  };
});

// ../../node_modules/fs-minipass/index.js
var require_fs_minipass = __commonJS((exports) => {
  var MiniPass = require_minipass3();
  var EE = __require("events").EventEmitter;
  var fs = __require("fs");
  var writev = fs.writev;
  if (!writev) {
    const binding = process.binding("fs");
    const FSReqWrap = binding.FSReqWrap || binding.FSReqCallback;
    writev = (fd, iovec, pos, cb) => {
      const done = (er, bw) => cb(er, bw, iovec);
      const req = new FSReqWrap;
      req.oncomplete = done;
      binding.writeBuffers(fd, iovec, pos, req);
    };
  }
  var _autoClose = Symbol("_autoClose");
  var _close = Symbol("_close");
  var _ended = Symbol("_ended");
  var _fd = Symbol("_fd");
  var _finished = Symbol("_finished");
  var _flags = Symbol("_flags");
  var _flush = Symbol("_flush");
  var _handleChunk = Symbol("_handleChunk");
  var _makeBuf = Symbol("_makeBuf");
  var _mode = Symbol("_mode");
  var _needDrain = Symbol("_needDrain");
  var _onerror = Symbol("_onerror");
  var _onopen = Symbol("_onopen");
  var _onread = Symbol("_onread");
  var _onwrite = Symbol("_onwrite");
  var _open = Symbol("_open");
  var _path = Symbol("_path");
  var _pos = Symbol("_pos");
  var _queue = Symbol("_queue");
  var _read = Symbol("_read");
  var _readSize = Symbol("_readSize");
  var _reading = Symbol("_reading");
  var _remain = Symbol("_remain");
  var _size = Symbol("_size");
  var _write = Symbol("_write");
  var _writing = Symbol("_writing");
  var _defaultFlag = Symbol("_defaultFlag");
  var _errored = Symbol("_errored");

  class ReadStream extends MiniPass {
    constructor(path, opt) {
      opt = opt || {};
      super(opt);
      this.readable = true;
      this.writable = false;
      if (typeof path !== "string")
        throw new TypeError("path must be a string");
      this[_errored] = false;
      this[_fd] = typeof opt.fd === "number" ? opt.fd : null;
      this[_path] = path;
      this[_readSize] = opt.readSize || 16 * 1024 * 1024;
      this[_reading] = false;
      this[_size] = typeof opt.size === "number" ? opt.size : Infinity;
      this[_remain] = this[_size];
      this[_autoClose] = typeof opt.autoClose === "boolean" ? opt.autoClose : true;
      if (typeof this[_fd] === "number")
        this[_read]();
      else
        this[_open]();
    }
    get fd() {
      return this[_fd];
    }
    get path() {
      return this[_path];
    }
    write() {
      throw new TypeError("this is a readable stream");
    }
    end() {
      throw new TypeError("this is a readable stream");
    }
    [_open]() {
      fs.open(this[_path], "r", (er, fd) => this[_onopen](er, fd));
    }
    [_onopen](er, fd) {
      if (er)
        this[_onerror](er);
      else {
        this[_fd] = fd;
        this.emit("open", fd);
        this[_read]();
      }
    }
    [_makeBuf]() {
      return Buffer.allocUnsafe(Math.min(this[_readSize], this[_remain]));
    }
    [_read]() {
      if (!this[_reading]) {
        this[_reading] = true;
        const buf = this[_makeBuf]();
        if (buf.length === 0)
          return process.nextTick(() => this[_onread](null, 0, buf));
        fs.read(this[_fd], buf, 0, buf.length, null, (er, br, buf2) => this[_onread](er, br, buf2));
      }
    }
    [_onread](er, br, buf) {
      this[_reading] = false;
      if (er)
        this[_onerror](er);
      else if (this[_handleChunk](br, buf))
        this[_read]();
    }
    [_close]() {
      if (this[_autoClose] && typeof this[_fd] === "number") {
        const fd = this[_fd];
        this[_fd] = null;
        fs.close(fd, (er) => er ? this.emit("error", er) : this.emit("close"));
      }
    }
    [_onerror](er) {
      this[_reading] = true;
      this[_close]();
      this.emit("error", er);
    }
    [_handleChunk](br, buf) {
      let ret = false;
      this[_remain] -= br;
      if (br > 0)
        ret = super.write(br < buf.length ? buf.slice(0, br) : buf);
      if (br === 0 || this[_remain] <= 0) {
        ret = false;
        this[_close]();
        super.end();
      }
      return ret;
    }
    emit(ev, data) {
      switch (ev) {
        case "prefinish":
        case "finish":
          break;
        case "drain":
          if (typeof this[_fd] === "number")
            this[_read]();
          break;
        case "error":
          if (this[_errored])
            return;
          this[_errored] = true;
          return super.emit(ev, data);
        default:
          return super.emit(ev, data);
      }
    }
  }

  class ReadStreamSync extends ReadStream {
    [_open]() {
      let threw = true;
      try {
        this[_onopen](null, fs.openSync(this[_path], "r"));
        threw = false;
      } finally {
        if (threw)
          this[_close]();
      }
    }
    [_read]() {
      let threw = true;
      try {
        if (!this[_reading]) {
          this[_reading] = true;
          do {
            const buf = this[_makeBuf]();
            const br = buf.length === 0 ? 0 : fs.readSync(this[_fd], buf, 0, buf.length, null);
            if (!this[_handleChunk](br, buf))
              break;
          } while (true);
          this[_reading] = false;
        }
        threw = false;
      } finally {
        if (threw)
          this[_close]();
      }
    }
    [_close]() {
      if (this[_autoClose] && typeof this[_fd] === "number") {
        const fd = this[_fd];
        this[_fd] = null;
        fs.closeSync(fd);
        this.emit("close");
      }
    }
  }

  class WriteStream extends EE {
    constructor(path, opt) {
      opt = opt || {};
      super(opt);
      this.readable = false;
      this.writable = true;
      this[_errored] = false;
      this[_writing] = false;
      this[_ended] = false;
      this[_needDrain] = false;
      this[_queue] = [];
      this[_path] = path;
      this[_fd] = typeof opt.fd === "number" ? opt.fd : null;
      this[_mode] = opt.mode === undefined ? 438 : opt.mode;
      this[_pos] = typeof opt.start === "number" ? opt.start : null;
      this[_autoClose] = typeof opt.autoClose === "boolean" ? opt.autoClose : true;
      const defaultFlag = this[_pos] !== null ? "r+" : "w";
      this[_defaultFlag] = opt.flags === undefined;
      this[_flags] = this[_defaultFlag] ? defaultFlag : opt.flags;
      if (this[_fd] === null)
        this[_open]();
    }
    emit(ev, data) {
      if (ev === "error") {
        if (this[_errored])
          return;
        this[_errored] = true;
      }
      return super.emit(ev, data);
    }
    get fd() {
      return this[_fd];
    }
    get path() {
      return this[_path];
    }
    [_onerror](er) {
      this[_close]();
      this[_writing] = true;
      this.emit("error", er);
    }
    [_open]() {
      fs.open(this[_path], this[_flags], this[_mode], (er, fd) => this[_onopen](er, fd));
    }
    [_onopen](er, fd) {
      if (this[_defaultFlag] && this[_flags] === "r+" && er && er.code === "ENOENT") {
        this[_flags] = "w";
        this[_open]();
      } else if (er)
        this[_onerror](er);
      else {
        this[_fd] = fd;
        this.emit("open", fd);
        this[_flush]();
      }
    }
    end(buf, enc) {
      if (buf)
        this.write(buf, enc);
      this[_ended] = true;
      if (!this[_writing] && !this[_queue].length && typeof this[_fd] === "number")
        this[_onwrite](null, 0);
      return this;
    }
    write(buf, enc) {
      if (typeof buf === "string")
        buf = Buffer.from(buf, enc);
      if (this[_ended]) {
        this.emit("error", new Error("write() after end()"));
        return false;
      }
      if (this[_fd] === null || this[_writing] || this[_queue].length) {
        this[_queue].push(buf);
        this[_needDrain] = true;
        return false;
      }
      this[_writing] = true;
      this[_write](buf);
      return true;
    }
    [_write](buf) {
      fs.write(this[_fd], buf, 0, buf.length, this[_pos], (er, bw) => this[_onwrite](er, bw));
    }
    [_onwrite](er, bw) {
      if (er)
        this[_onerror](er);
      else {
        if (this[_pos] !== null)
          this[_pos] += bw;
        if (this[_queue].length)
          this[_flush]();
        else {
          this[_writing] = false;
          if (this[_ended] && !this[_finished]) {
            this[_finished] = true;
            this[_close]();
            this.emit("finish");
          } else if (this[_needDrain]) {
            this[_needDrain] = false;
            this.emit("drain");
          }
        }
      }
    }
    [_flush]() {
      if (this[_queue].length === 0) {
        if (this[_ended])
          this[_onwrite](null, 0);
      } else if (this[_queue].length === 1)
        this[_write](this[_queue].pop());
      else {
        const iovec = this[_queue];
        this[_queue] = [];
        writev(this[_fd], iovec, this[_pos], (er, bw) => this[_onwrite](er, bw));
      }
    }
    [_close]() {
      if (this[_autoClose] && typeof this[_fd] === "number") {
        const fd = this[_fd];
        this[_fd] = null;
        fs.close(fd, (er) => er ? this.emit("error", er) : this.emit("close"));
      }
    }
  }

  class WriteStreamSync extends WriteStream {
    [_open]() {
      let fd;
      if (this[_defaultFlag] && this[_flags] === "r+") {
        try {
          fd = fs.openSync(this[_path], this[_flags], this[_mode]);
        } catch (er) {
          if (er.code === "ENOENT") {
            this[_flags] = "w";
            return this[_open]();
          } else
            throw er;
        }
      } else
        fd = fs.openSync(this[_path], this[_flags], this[_mode]);
      this[_onopen](null, fd);
    }
    [_close]() {
      if (this[_autoClose] && typeof this[_fd] === "number") {
        const fd = this[_fd];
        this[_fd] = null;
        fs.closeSync(fd);
        this.emit("close");
      }
    }
    [_write](buf) {
      let threw = true;
      try {
        this[_onwrite](null, fs.writeSync(this[_fd], buf, 0, buf.length, this[_pos]));
        threw = false;
      } finally {
        if (threw)
          try {
            this[_close]();
          } catch (_) {}
      }
    }
  }
  exports.ReadStream = ReadStream;
  exports.ReadStreamSync = ReadStreamSync;
  exports.WriteStream = WriteStream;
  exports.WriteStreamSync = WriteStreamSync;
});

// ../../node_modules/tar/lib/parse.js
var require_parse = __commonJS((exports, module) => {
  var warner = require_warn_mixin();
  var Header = require_header();
  var EE = __require("events");
  var Yallist = require_yallist();
  var maxMetaEntrySize = 1024 * 1024;
  var Entry = require_read_entry();
  var Pax = require_pax();
  var zlib = require_minizlib();
  var { nextTick } = __require("process");
  var gzipHeader = Buffer.from([31, 139]);
  var STATE = Symbol("state");
  var WRITEENTRY = Symbol("writeEntry");
  var READENTRY = Symbol("readEntry");
  var NEXTENTRY = Symbol("nextEntry");
  var PROCESSENTRY = Symbol("processEntry");
  var EX = Symbol("extendedHeader");
  var GEX = Symbol("globalExtendedHeader");
  var META = Symbol("meta");
  var EMITMETA = Symbol("emitMeta");
  var BUFFER = Symbol("buffer");
  var QUEUE = Symbol("queue");
  var ENDED = Symbol("ended");
  var EMITTEDEND = Symbol("emittedEnd");
  var EMIT = Symbol("emit");
  var UNZIP = Symbol("unzip");
  var CONSUMECHUNK = Symbol("consumeChunk");
  var CONSUMECHUNKSUB = Symbol("consumeChunkSub");
  var CONSUMEBODY = Symbol("consumeBody");
  var CONSUMEMETA = Symbol("consumeMeta");
  var CONSUMEHEADER = Symbol("consumeHeader");
  var CONSUMING = Symbol("consuming");
  var BUFFERCONCAT = Symbol("bufferConcat");
  var MAYBEEND = Symbol("maybeEnd");
  var WRITING = Symbol("writing");
  var ABORTED = Symbol("aborted");
  var DONE = Symbol("onDone");
  var SAW_VALID_ENTRY = Symbol("sawValidEntry");
  var SAW_NULL_BLOCK = Symbol("sawNullBlock");
  var SAW_EOF = Symbol("sawEOF");
  var CLOSESTREAM = Symbol("closeStream");
  var noop = (_) => true;
  module.exports = warner(class Parser extends EE {
    constructor(opt) {
      opt = opt || {};
      super(opt);
      this.file = opt.file || "";
      this[SAW_VALID_ENTRY] = null;
      this.on(DONE, (_) => {
        if (this[STATE] === "begin" || this[SAW_VALID_ENTRY] === false) {
          this.warn("TAR_BAD_ARCHIVE", "Unrecognized archive format");
        }
      });
      if (opt.ondone) {
        this.on(DONE, opt.ondone);
      } else {
        this.on(DONE, (_) => {
          this.emit("prefinish");
          this.emit("finish");
          this.emit("end");
        });
      }
      this.strict = !!opt.strict;
      this.maxMetaEntrySize = opt.maxMetaEntrySize || maxMetaEntrySize;
      this.filter = typeof opt.filter === "function" ? opt.filter : noop;
      const isTBR = opt.file && (opt.file.endsWith(".tar.br") || opt.file.endsWith(".tbr"));
      this.brotli = !opt.gzip && opt.brotli !== undefined ? opt.brotli : isTBR ? undefined : false;
      this.writable = true;
      this.readable = false;
      this[QUEUE] = new Yallist;
      this[BUFFER] = null;
      this[READENTRY] = null;
      this[WRITEENTRY] = null;
      this[STATE] = "begin";
      this[META] = "";
      this[EX] = null;
      this[GEX] = null;
      this[ENDED] = false;
      this[UNZIP] = null;
      this[ABORTED] = false;
      this[SAW_NULL_BLOCK] = false;
      this[SAW_EOF] = false;
      this.on("end", () => this[CLOSESTREAM]());
      if (typeof opt.onwarn === "function") {
        this.on("warn", opt.onwarn);
      }
      if (typeof opt.onentry === "function") {
        this.on("entry", opt.onentry);
      }
    }
    [CONSUMEHEADER](chunk, position) {
      if (this[SAW_VALID_ENTRY] === null) {
        this[SAW_VALID_ENTRY] = false;
      }
      let header;
      try {
        header = new Header(chunk, position, this[EX], this[GEX]);
      } catch (er) {
        return this.warn("TAR_ENTRY_INVALID", er);
      }
      if (header.nullBlock) {
        if (this[SAW_NULL_BLOCK]) {
          this[SAW_EOF] = true;
          if (this[STATE] === "begin") {
            this[STATE] = "header";
          }
          this[EMIT]("eof");
        } else {
          this[SAW_NULL_BLOCK] = true;
          this[EMIT]("nullBlock");
        }
      } else {
        this[SAW_NULL_BLOCK] = false;
        if (!header.cksumValid) {
          this.warn("TAR_ENTRY_INVALID", "checksum failure", { header });
        } else if (!header.path) {
          this.warn("TAR_ENTRY_INVALID", "path is required", { header });
        } else {
          const type = header.type;
          if (/^(Symbolic)?Link$/.test(type) && !header.linkpath) {
            this.warn("TAR_ENTRY_INVALID", "linkpath required", { header });
          } else if (!/^(Symbolic)?Link$/.test(type) && header.linkpath) {
            this.warn("TAR_ENTRY_INVALID", "linkpath forbidden", { header });
          } else {
            const entry = this[WRITEENTRY] = new Entry(header, this[EX], this[GEX]);
            if (!this[SAW_VALID_ENTRY]) {
              if (entry.remain) {
                const onend = () => {
                  if (!entry.invalid) {
                    this[SAW_VALID_ENTRY] = true;
                  }
                };
                entry.on("end", onend);
              } else {
                this[SAW_VALID_ENTRY] = true;
              }
            }
            if (entry.meta) {
              if (entry.size > this.maxMetaEntrySize) {
                entry.ignore = true;
                this[EMIT]("ignoredEntry", entry);
                this[STATE] = "ignore";
                entry.resume();
              } else if (entry.size > 0) {
                this[META] = "";
                entry.on("data", (c) => this[META] += c);
                this[STATE] = "meta";
              }
            } else {
              this[EX] = null;
              entry.ignore = entry.ignore || !this.filter(entry.path, entry);
              if (entry.ignore) {
                this[EMIT]("ignoredEntry", entry);
                this[STATE] = entry.remain ? "ignore" : "header";
                entry.resume();
              } else {
                if (entry.remain) {
                  this[STATE] = "body";
                } else {
                  this[STATE] = "header";
                  entry.end();
                }
                if (!this[READENTRY]) {
                  this[QUEUE].push(entry);
                  this[NEXTENTRY]();
                } else {
                  this[QUEUE].push(entry);
                }
              }
            }
          }
        }
      }
    }
    [CLOSESTREAM]() {
      nextTick(() => this.emit("close"));
    }
    [PROCESSENTRY](entry) {
      let go = true;
      if (!entry) {
        this[READENTRY] = null;
        go = false;
      } else if (Array.isArray(entry)) {
        this.emit.apply(this, entry);
      } else {
        this[READENTRY] = entry;
        this.emit("entry", entry);
        if (!entry.emittedEnd) {
          entry.on("end", (_) => this[NEXTENTRY]());
          go = false;
        }
      }
      return go;
    }
    [NEXTENTRY]() {
      do {} while (this[PROCESSENTRY](this[QUEUE].shift()));
      if (!this[QUEUE].length) {
        const re = this[READENTRY];
        const drainNow = !re || re.flowing || re.size === re.remain;
        if (drainNow) {
          if (!this[WRITING]) {
            this.emit("drain");
          }
        } else {
          re.once("drain", (_) => this.emit("drain"));
        }
      }
    }
    [CONSUMEBODY](chunk, position) {
      const entry = this[WRITEENTRY];
      const br = entry.blockRemain;
      const c = br >= chunk.length && position === 0 ? chunk : chunk.slice(position, position + br);
      entry.write(c);
      if (!entry.blockRemain) {
        this[STATE] = "header";
        this[WRITEENTRY] = null;
        entry.end();
      }
      return c.length;
    }
    [CONSUMEMETA](chunk, position) {
      const entry = this[WRITEENTRY];
      const ret = this[CONSUMEBODY](chunk, position);
      if (!this[WRITEENTRY]) {
        this[EMITMETA](entry);
      }
      return ret;
    }
    [EMIT](ev, data, extra) {
      if (!this[QUEUE].length && !this[READENTRY]) {
        this.emit(ev, data, extra);
      } else {
        this[QUEUE].push([ev, data, extra]);
      }
    }
    [EMITMETA](entry) {
      this[EMIT]("meta", this[META]);
      switch (entry.type) {
        case "ExtendedHeader":
        case "OldExtendedHeader":
          this[EX] = Pax.parse(this[META], this[EX], false);
          break;
        case "GlobalExtendedHeader":
          this[GEX] = Pax.parse(this[META], this[GEX], true);
          break;
        case "NextFileHasLongPath":
        case "OldGnuLongPath":
          this[EX] = this[EX] || Object.create(null);
          this[EX].path = this[META].replace(/\0.*/, "");
          break;
        case "NextFileHasLongLinkpath":
          this[EX] = this[EX] || Object.create(null);
          this[EX].linkpath = this[META].replace(/\0.*/, "");
          break;
        default:
          throw new Error("unknown meta: " + entry.type);
      }
    }
    abort(error) {
      this[ABORTED] = true;
      this.emit("abort", error);
      this.warn("TAR_ABORT", error, { recoverable: false });
    }
    write(chunk) {
      if (this[ABORTED]) {
        return;
      }
      const needSniff = this[UNZIP] === null || this.brotli === undefined && this[UNZIP] === false;
      if (needSniff && chunk) {
        if (this[BUFFER]) {
          chunk = Buffer.concat([this[BUFFER], chunk]);
          this[BUFFER] = null;
        }
        if (chunk.length < gzipHeader.length) {
          this[BUFFER] = chunk;
          return true;
        }
        for (let i = 0;this[UNZIP] === null && i < gzipHeader.length; i++) {
          if (chunk[i] !== gzipHeader[i]) {
            this[UNZIP] = false;
          }
        }
        const maybeBrotli = this.brotli === undefined;
        if (this[UNZIP] === false && maybeBrotli) {
          if (chunk.length < 512) {
            if (this[ENDED]) {
              this.brotli = true;
            } else {
              this[BUFFER] = chunk;
              return true;
            }
          } else {
            try {
              new Header(chunk.slice(0, 512));
              this.brotli = false;
            } catch (_) {
              this.brotli = true;
            }
          }
        }
        if (this[UNZIP] === null || this[UNZIP] === false && this.brotli) {
          const ended = this[ENDED];
          this[ENDED] = false;
          this[UNZIP] = this[UNZIP] === null ? new zlib.Unzip : new zlib.BrotliDecompress;
          this[UNZIP].on("data", (chunk2) => this[CONSUMECHUNK](chunk2));
          this[UNZIP].on("error", (er) => this.abort(er));
          this[UNZIP].on("end", (_) => {
            this[ENDED] = true;
            this[CONSUMECHUNK]();
          });
          this[WRITING] = true;
          const ret2 = this[UNZIP][ended ? "end" : "write"](chunk);
          this[WRITING] = false;
          return ret2;
        }
      }
      this[WRITING] = true;
      if (this[UNZIP]) {
        this[UNZIP].write(chunk);
      } else {
        this[CONSUMECHUNK](chunk);
      }
      this[WRITING] = false;
      const ret = this[QUEUE].length ? false : this[READENTRY] ? this[READENTRY].flowing : true;
      if (!ret && !this[QUEUE].length) {
        this[READENTRY].once("drain", (_) => this.emit("drain"));
      }
      return ret;
    }
    [BUFFERCONCAT](c) {
      if (c && !this[ABORTED]) {
        this[BUFFER] = this[BUFFER] ? Buffer.concat([this[BUFFER], c]) : c;
      }
    }
    [MAYBEEND]() {
      if (this[ENDED] && !this[EMITTEDEND] && !this[ABORTED] && !this[CONSUMING]) {
        this[EMITTEDEND] = true;
        const entry = this[WRITEENTRY];
        if (entry && entry.blockRemain) {
          const have = this[BUFFER] ? this[BUFFER].length : 0;
          this.warn("TAR_BAD_ARCHIVE", `Truncated input (needed ${entry.blockRemain} more bytes, only ${have} available)`, { entry });
          if (this[BUFFER]) {
            entry.write(this[BUFFER]);
          }
          entry.end();
        }
        this[EMIT](DONE);
      }
    }
    [CONSUMECHUNK](chunk) {
      if (this[CONSUMING]) {
        this[BUFFERCONCAT](chunk);
      } else if (!chunk && !this[BUFFER]) {
        this[MAYBEEND]();
      } else {
        this[CONSUMING] = true;
        if (this[BUFFER]) {
          this[BUFFERCONCAT](chunk);
          const c = this[BUFFER];
          this[BUFFER] = null;
          this[CONSUMECHUNKSUB](c);
        } else {
          this[CONSUMECHUNKSUB](chunk);
        }
        while (this[BUFFER] && this[BUFFER].length >= 512 && !this[ABORTED] && !this[SAW_EOF]) {
          const c = this[BUFFER];
          this[BUFFER] = null;
          this[CONSUMECHUNKSUB](c);
        }
        this[CONSUMING] = false;
      }
      if (!this[BUFFER] || this[ENDED]) {
        this[MAYBEEND]();
      }
    }
    [CONSUMECHUNKSUB](chunk) {
      let position = 0;
      const length = chunk.length;
      while (position + 512 <= length && !this[ABORTED] && !this[SAW_EOF]) {
        switch (this[STATE]) {
          case "begin":
          case "header":
            this[CONSUMEHEADER](chunk, position);
            position += 512;
            break;
          case "ignore":
          case "body":
            position += this[CONSUMEBODY](chunk, position);
            break;
          case "meta":
            position += this[CONSUMEMETA](chunk, position);
            break;
          default:
            throw new Error("invalid state: " + this[STATE]);
        }
      }
      if (position < length) {
        if (this[BUFFER]) {
          this[BUFFER] = Buffer.concat([chunk.slice(position), this[BUFFER]]);
        } else {
          this[BUFFER] = chunk.slice(position);
        }
      }
    }
    end(chunk) {
      if (!this[ABORTED]) {
        if (this[UNZIP]) {
          this[UNZIP].end(chunk);
        } else {
          this[ENDED] = true;
          if (this.brotli === undefined)
            chunk = chunk || Buffer.alloc(0);
          this.write(chunk);
        }
      }
    }
  });
});

// ../../node_modules/tar/lib/list.js
var require_list = __commonJS((exports, module) => {
  var hlo = require_high_level_opt();
  var Parser = require_parse();
  var fs = __require("fs");
  var fsm = require_fs_minipass();
  var path = __require("path");
  var stripSlash = require_strip_trailing_slashes();
  module.exports = (opt_, files, cb) => {
    if (typeof opt_ === "function") {
      cb = opt_, files = null, opt_ = {};
    } else if (Array.isArray(opt_)) {
      files = opt_, opt_ = {};
    }
    if (typeof files === "function") {
      cb = files, files = null;
    }
    if (!files) {
      files = [];
    } else {
      files = Array.from(files);
    }
    const opt = hlo(opt_);
    if (opt.sync && typeof cb === "function") {
      throw new TypeError("callback not supported for sync tar functions");
    }
    if (!opt.file && typeof cb === "function") {
      throw new TypeError("callback only supported with file option");
    }
    if (files.length) {
      filesFilter(opt, files);
    }
    if (!opt.noResume) {
      onentryFunction(opt);
    }
    return opt.file && opt.sync ? listFileSync(opt) : opt.file ? listFile(opt, cb) : list(opt);
  };
  var onentryFunction = (opt) => {
    const onentry = opt.onentry;
    opt.onentry = onentry ? (e) => {
      onentry(e);
      e.resume();
    } : (e) => e.resume();
  };
  var filesFilter = (opt, files) => {
    const map = new Map(files.map((f) => [stripSlash(f), true]));
    const filter = opt.filter;
    const mapHas = (file, r) => {
      const root = r || path.parse(file).root || ".";
      const ret = file === root ? false : map.has(file) ? map.get(file) : mapHas(path.dirname(file), root);
      map.set(file, ret);
      return ret;
    };
    opt.filter = filter ? (file, entry) => filter(file, entry) && mapHas(stripSlash(file)) : (file) => mapHas(stripSlash(file));
  };
  var listFileSync = (opt) => {
    const p = list(opt);
    const file = opt.file;
    let threw = true;
    let fd;
    try {
      const stat = fs.statSync(file);
      const readSize = opt.maxReadSize || 16 * 1024 * 1024;
      if (stat.size < readSize) {
        p.end(fs.readFileSync(file));
      } else {
        let pos = 0;
        const buf = Buffer.allocUnsafe(readSize);
        fd = fs.openSync(file, "r");
        while (pos < stat.size) {
          const bytesRead = fs.readSync(fd, buf, 0, readSize, pos);
          pos += bytesRead;
          p.write(buf.slice(0, bytesRead));
        }
        p.end();
      }
      threw = false;
    } finally {
      if (threw && fd) {
        try {
          fs.closeSync(fd);
        } catch (er) {}
      }
    }
  };
  var listFile = (opt, cb) => {
    const parse = new Parser(opt);
    const readSize = opt.maxReadSize || 16 * 1024 * 1024;
    const file = opt.file;
    const p = new Promise((resolve, reject) => {
      parse.on("error", reject);
      parse.on("end", resolve);
      fs.stat(file, (er, stat) => {
        if (er) {
          reject(er);
        } else {
          const stream = new fsm.ReadStream(file, {
            readSize,
            size: stat.size
          });
          stream.on("error", reject);
          stream.pipe(parse);
        }
      });
    });
    return cb ? p.then(cb, cb) : p;
  };
  var list = (opt) => new Parser(opt);
});

// ../../node_modules/tar/lib/create.js
var require_create = __commonJS((exports, module) => {
  var hlo = require_high_level_opt();
  var Pack = require_pack();
  var fsm = require_fs_minipass();
  var t = require_list();
  var path = __require("path");
  module.exports = (opt_, files, cb) => {
    if (typeof files === "function") {
      cb = files;
    }
    if (Array.isArray(opt_)) {
      files = opt_, opt_ = {};
    }
    if (!files || !Array.isArray(files) || !files.length) {
      throw new TypeError("no files or directories specified");
    }
    files = Array.from(files);
    const opt = hlo(opt_);
    if (opt.sync && typeof cb === "function") {
      throw new TypeError("callback not supported for sync tar functions");
    }
    if (!opt.file && typeof cb === "function") {
      throw new TypeError("callback only supported with file option");
    }
    return opt.file && opt.sync ? createFileSync(opt, files) : opt.file ? createFile(opt, files, cb) : opt.sync ? createSync(opt, files) : create(opt, files);
  };
  var createFileSync = (opt, files) => {
    const p = new Pack.Sync(opt);
    const stream = new fsm.WriteStreamSync(opt.file, {
      mode: opt.mode || 438
    });
    p.pipe(stream);
    addFilesSync(p, files);
  };
  var createFile = (opt, files, cb) => {
    const p = new Pack(opt);
    const stream = new fsm.WriteStream(opt.file, {
      mode: opt.mode || 438
    });
    p.pipe(stream);
    const promise = new Promise((res, rej) => {
      stream.on("error", rej);
      stream.on("close", res);
      p.on("error", rej);
    });
    addFilesAsync(p, files);
    return cb ? promise.then(cb, cb) : promise;
  };
  var addFilesSync = (p, files) => {
    files.forEach((file) => {
      if (file.charAt(0) === "@") {
        t({
          file: path.resolve(p.cwd, file.slice(1)),
          sync: true,
          noResume: true,
          onentry: (entry) => p.add(entry)
        });
      } else {
        p.add(file);
      }
    });
    p.end();
  };
  var addFilesAsync = (p, files) => {
    while (files.length) {
      const file = files.shift();
      if (file.charAt(0) === "@") {
        return t({
          file: path.resolve(p.cwd, file.slice(1)),
          noResume: true,
          onentry: (entry) => p.add(entry)
        }).then((_) => addFilesAsync(p, files));
      } else {
        p.add(file);
      }
    }
    p.end();
  };
  var createSync = (opt, files) => {
    const p = new Pack.Sync(opt);
    addFilesSync(p, files);
    return p;
  };
  var create = (opt, files) => {
    const p = new Pack(opt);
    addFilesAsync(p, files);
    return p;
  };
});

// ../../node_modules/tar/lib/replace.js
var require_replace = __commonJS((exports, module) => {
  var hlo = require_high_level_opt();
  var Pack = require_pack();
  var fs = __require("fs");
  var fsm = require_fs_minipass();
  var t = require_list();
  var path = __require("path");
  var Header = require_header();
  module.exports = (opt_, files, cb) => {
    const opt = hlo(opt_);
    if (!opt.file) {
      throw new TypeError("file is required");
    }
    if (opt.gzip || opt.brotli || opt.file.endsWith(".br") || opt.file.endsWith(".tbr")) {
      throw new TypeError("cannot append to compressed archives");
    }
    if (!files || !Array.isArray(files) || !files.length) {
      throw new TypeError("no files or directories specified");
    }
    files = Array.from(files);
    return opt.sync ? replaceSync(opt, files) : replace(opt, files, cb);
  };
  var replaceSync = (opt, files) => {
    const p = new Pack.Sync(opt);
    let threw = true;
    let fd;
    let position;
    try {
      try {
        fd = fs.openSync(opt.file, "r+");
      } catch (er) {
        if (er.code === "ENOENT") {
          fd = fs.openSync(opt.file, "w+");
        } else {
          throw er;
        }
      }
      const st = fs.fstatSync(fd);
      const headBuf = Buffer.alloc(512);
      POSITION:
        for (position = 0;position < st.size; position += 512) {
          for (let bufPos = 0, bytes = 0;bufPos < 512; bufPos += bytes) {
            bytes = fs.readSync(fd, headBuf, bufPos, headBuf.length - bufPos, position + bufPos);
            if (position === 0 && headBuf[0] === 31 && headBuf[1] === 139) {
              throw new Error("cannot append to compressed archives");
            }
            if (!bytes) {
              break POSITION;
            }
          }
          const h = new Header(headBuf);
          if (!h.cksumValid) {
            break;
          }
          const entryBlockSize = 512 * Math.ceil(h.size / 512);
          if (position + entryBlockSize + 512 > st.size) {
            break;
          }
          position += entryBlockSize;
          if (opt.mtimeCache) {
            opt.mtimeCache.set(h.path, h.mtime);
          }
        }
      threw = false;
      streamSync(opt, p, position, fd, files);
    } finally {
      if (threw) {
        try {
          fs.closeSync(fd);
        } catch (er) {}
      }
    }
  };
  var streamSync = (opt, p, position, fd, files) => {
    const stream = new fsm.WriteStreamSync(opt.file, {
      fd,
      start: position
    });
    p.pipe(stream);
    addFilesSync(p, files);
  };
  var replace = (opt, files, cb) => {
    files = Array.from(files);
    const p = new Pack(opt);
    const getPos = (fd, size, cb_) => {
      const cb2 = (er, pos) => {
        if (er) {
          fs.close(fd, (_) => cb_(er));
        } else {
          cb_(null, pos);
        }
      };
      let position = 0;
      if (size === 0) {
        return cb2(null, 0);
      }
      let bufPos = 0;
      const headBuf = Buffer.alloc(512);
      const onread = (er, bytes) => {
        if (er) {
          return cb2(er);
        }
        bufPos += bytes;
        if (bufPos < 512 && bytes) {
          return fs.read(fd, headBuf, bufPos, headBuf.length - bufPos, position + bufPos, onread);
        }
        if (position === 0 && headBuf[0] === 31 && headBuf[1] === 139) {
          return cb2(new Error("cannot append to compressed archives"));
        }
        if (bufPos < 512) {
          return cb2(null, position);
        }
        const h = new Header(headBuf);
        if (!h.cksumValid) {
          return cb2(null, position);
        }
        const entryBlockSize = 512 * Math.ceil(h.size / 512);
        if (position + entryBlockSize + 512 > size) {
          return cb2(null, position);
        }
        position += entryBlockSize + 512;
        if (position >= size) {
          return cb2(null, position);
        }
        if (opt.mtimeCache) {
          opt.mtimeCache.set(h.path, h.mtime);
        }
        bufPos = 0;
        fs.read(fd, headBuf, 0, 512, position, onread);
      };
      fs.read(fd, headBuf, 0, 512, position, onread);
    };
    const promise = new Promise((resolve, reject) => {
      p.on("error", reject);
      let flag = "r+";
      const onopen = (er, fd) => {
        if (er && er.code === "ENOENT" && flag === "r+") {
          flag = "w+";
          return fs.open(opt.file, flag, onopen);
        }
        if (er) {
          return reject(er);
        }
        fs.fstat(fd, (er2, st) => {
          if (er2) {
            return fs.close(fd, () => reject(er2));
          }
          getPos(fd, st.size, (er3, position) => {
            if (er3) {
              return reject(er3);
            }
            const stream = new fsm.WriteStream(opt.file, {
              fd,
              start: position
            });
            p.pipe(stream);
            stream.on("error", reject);
            stream.on("close", resolve);
            addFilesAsync(p, files);
          });
        });
      };
      fs.open(opt.file, flag, onopen);
    });
    return cb ? promise.then(cb, cb) : promise;
  };
  var addFilesSync = (p, files) => {
    files.forEach((file) => {
      if (file.charAt(0) === "@") {
        t({
          file: path.resolve(p.cwd, file.slice(1)),
          sync: true,
          noResume: true,
          onentry: (entry) => p.add(entry)
        });
      } else {
        p.add(file);
      }
    });
    p.end();
  };
  var addFilesAsync = (p, files) => {
    while (files.length) {
      const file = files.shift();
      if (file.charAt(0) === "@") {
        return t({
          file: path.resolve(p.cwd, file.slice(1)),
          noResume: true,
          onentry: (entry) => p.add(entry)
        }).then((_) => addFilesAsync(p, files));
      } else {
        p.add(file);
      }
    }
    p.end();
  };
});

// ../../node_modules/tar/lib/update.js
var require_update = __commonJS((exports, module) => {
  var hlo = require_high_level_opt();
  var r = require_replace();
  module.exports = (opt_, files, cb) => {
    const opt = hlo(opt_);
    if (!opt.file) {
      throw new TypeError("file is required");
    }
    if (opt.gzip || opt.brotli || opt.file.endsWith(".br") || opt.file.endsWith(".tbr")) {
      throw new TypeError("cannot append to compressed archives");
    }
    if (!files || !Array.isArray(files) || !files.length) {
      throw new TypeError("no files or directories specified");
    }
    files = Array.from(files);
    mtimeFilter(opt);
    return r(opt, files, cb);
  };
  var mtimeFilter = (opt) => {
    const filter = opt.filter;
    if (!opt.mtimeCache) {
      opt.mtimeCache = new Map;
    }
    opt.filter = filter ? (path, stat) => filter(path, stat) && !(opt.mtimeCache.get(path) > stat.mtime) : (path, stat) => !(opt.mtimeCache.get(path) > stat.mtime);
  };
});

// ../../node_modules/mkdirp/lib/opts-arg.js
var require_opts_arg = __commonJS((exports, module) => {
  var { promisify: promisify3 } = __require("util");
  var fs = __require("fs");
  var optsArg = (opts) => {
    if (!opts)
      opts = { mode: 511, fs };
    else if (typeof opts === "object")
      opts = { mode: 511, fs, ...opts };
    else if (typeof opts === "number")
      opts = { mode: opts, fs };
    else if (typeof opts === "string")
      opts = { mode: parseInt(opts, 8), fs };
    else
      throw new TypeError("invalid options argument");
    opts.mkdir = opts.mkdir || opts.fs.mkdir || fs.mkdir;
    opts.mkdirAsync = promisify3(opts.mkdir);
    opts.stat = opts.stat || opts.fs.stat || fs.stat;
    opts.statAsync = promisify3(opts.stat);
    opts.statSync = opts.statSync || opts.fs.statSync || fs.statSync;
    opts.mkdirSync = opts.mkdirSync || opts.fs.mkdirSync || fs.mkdirSync;
    return opts;
  };
  module.exports = optsArg;
});

// ../../node_modules/mkdirp/lib/path-arg.js
var require_path_arg = __commonJS((exports, module) => {
  var platform = process.env.__TESTING_MKDIRP_PLATFORM__ || process.platform;
  var { resolve, parse } = __require("path");
  var pathArg = (path) => {
    if (/\0/.test(path)) {
      throw Object.assign(new TypeError("path must be a string without null bytes"), {
        path,
        code: "ERR_INVALID_ARG_VALUE"
      });
    }
    path = resolve(path);
    if (platform === "win32") {
      const badWinChars = /[*|"<>?:]/;
      const { root } = parse(path);
      if (badWinChars.test(path.substr(root.length))) {
        throw Object.assign(new Error("Illegal characters in path."), {
          path,
          code: "EINVAL"
        });
      }
    }
    return path;
  };
  module.exports = pathArg;
});

// ../../node_modules/mkdirp/lib/find-made.js
var require_find_made = __commonJS((exports, module) => {
  var { dirname } = __require("path");
  var findMade = (opts, parent, path = undefined) => {
    if (path === parent)
      return Promise.resolve();
    return opts.statAsync(parent).then((st) => st.isDirectory() ? path : undefined, (er) => er.code === "ENOENT" ? findMade(opts, dirname(parent), parent) : undefined);
  };
  var findMadeSync = (opts, parent, path = undefined) => {
    if (path === parent)
      return;
    try {
      return opts.statSync(parent).isDirectory() ? path : undefined;
    } catch (er) {
      return er.code === "ENOENT" ? findMadeSync(opts, dirname(parent), parent) : undefined;
    }
  };
  module.exports = { findMade, findMadeSync };
});

// ../../node_modules/mkdirp/lib/mkdirp-manual.js
var require_mkdirp_manual = __commonJS((exports, module) => {
  var { dirname } = __require("path");
  var mkdirpManual = (path, opts, made) => {
    opts.recursive = false;
    const parent = dirname(path);
    if (parent === path) {
      return opts.mkdirAsync(path, opts).catch((er) => {
        if (er.code !== "EISDIR")
          throw er;
      });
    }
    return opts.mkdirAsync(path, opts).then(() => made || path, (er) => {
      if (er.code === "ENOENT")
        return mkdirpManual(parent, opts).then((made2) => mkdirpManual(path, opts, made2));
      if (er.code !== "EEXIST" && er.code !== "EROFS")
        throw er;
      return opts.statAsync(path).then((st) => {
        if (st.isDirectory())
          return made;
        else
          throw er;
      }, () => {
        throw er;
      });
    });
  };
  var mkdirpManualSync = (path, opts, made) => {
    const parent = dirname(path);
    opts.recursive = false;
    if (parent === path) {
      try {
        return opts.mkdirSync(path, opts);
      } catch (er) {
        if (er.code !== "EISDIR")
          throw er;
        else
          return;
      }
    }
    try {
      opts.mkdirSync(path, opts);
      return made || path;
    } catch (er) {
      if (er.code === "ENOENT")
        return mkdirpManualSync(path, opts, mkdirpManualSync(parent, opts, made));
      if (er.code !== "EEXIST" && er.code !== "EROFS")
        throw er;
      try {
        if (!opts.statSync(path).isDirectory())
          throw er;
      } catch (_) {
        throw er;
      }
    }
  };
  module.exports = { mkdirpManual, mkdirpManualSync };
});

// ../../node_modules/mkdirp/lib/mkdirp-native.js
var require_mkdirp_native = __commonJS((exports, module) => {
  var { dirname } = __require("path");
  var { findMade, findMadeSync } = require_find_made();
  var { mkdirpManual, mkdirpManualSync } = require_mkdirp_manual();
  var mkdirpNative = (path, opts) => {
    opts.recursive = true;
    const parent = dirname(path);
    if (parent === path)
      return opts.mkdirAsync(path, opts);
    return findMade(opts, path).then((made) => opts.mkdirAsync(path, opts).then(() => made).catch((er) => {
      if (er.code === "ENOENT")
        return mkdirpManual(path, opts);
      else
        throw er;
    }));
  };
  var mkdirpNativeSync = (path, opts) => {
    opts.recursive = true;
    const parent = dirname(path);
    if (parent === path)
      return opts.mkdirSync(path, opts);
    const made = findMadeSync(opts, path);
    try {
      opts.mkdirSync(path, opts);
      return made;
    } catch (er) {
      if (er.code === "ENOENT")
        return mkdirpManualSync(path, opts);
      else
        throw er;
    }
  };
  module.exports = { mkdirpNative, mkdirpNativeSync };
});

// ../../node_modules/mkdirp/lib/use-native.js
var require_use_native = __commonJS((exports, module) => {
  var fs = __require("fs");
  var version = process.env.__TESTING_MKDIRP_NODE_VERSION__ || process.version;
  var versArr = version.replace(/^v/, "").split(".");
  var hasNative = +versArr[0] > 10 || +versArr[0] === 10 && +versArr[1] >= 12;
  var useNative = !hasNative ? () => false : (opts) => opts.mkdir === fs.mkdir;
  var useNativeSync = !hasNative ? () => false : (opts) => opts.mkdirSync === fs.mkdirSync;
  module.exports = { useNative, useNativeSync };
});

// ../../node_modules/mkdirp/index.js
var require_mkdirp = __commonJS((exports, module) => {
  var optsArg = require_opts_arg();
  var pathArg = require_path_arg();
  var { mkdirpNative, mkdirpNativeSync } = require_mkdirp_native();
  var { mkdirpManual, mkdirpManualSync } = require_mkdirp_manual();
  var { useNative, useNativeSync } = require_use_native();
  var mkdirp = (path, opts) => {
    path = pathArg(path);
    opts = optsArg(opts);
    return useNative(opts) ? mkdirpNative(path, opts) : mkdirpManual(path, opts);
  };
  var mkdirpSync = (path, opts) => {
    path = pathArg(path);
    opts = optsArg(opts);
    return useNativeSync(opts) ? mkdirpNativeSync(path, opts) : mkdirpManualSync(path, opts);
  };
  mkdirp.sync = mkdirpSync;
  mkdirp.native = (path, opts) => mkdirpNative(pathArg(path), optsArg(opts));
  mkdirp.manual = (path, opts) => mkdirpManual(pathArg(path), optsArg(opts));
  mkdirp.nativeSync = (path, opts) => mkdirpNativeSync(pathArg(path), optsArg(opts));
  mkdirp.manualSync = (path, opts) => mkdirpManualSync(pathArg(path), optsArg(opts));
  module.exports = mkdirp;
});

// ../../node_modules/chownr/chownr.js
var require_chownr = __commonJS((exports, module) => {
  var fs = __require("fs");
  var path = __require("path");
  var LCHOWN = fs.lchown ? "lchown" : "chown";
  var LCHOWNSYNC = fs.lchownSync ? "lchownSync" : "chownSync";
  var needEISDIRHandled = fs.lchown && !process.version.match(/v1[1-9]+\./) && !process.version.match(/v10\.[6-9]/);
  var lchownSync = (path2, uid, gid) => {
    try {
      return fs[LCHOWNSYNC](path2, uid, gid);
    } catch (er) {
      if (er.code !== "ENOENT")
        throw er;
    }
  };
  var chownSync = (path2, uid, gid) => {
    try {
      return fs.chownSync(path2, uid, gid);
    } catch (er) {
      if (er.code !== "ENOENT")
        throw er;
    }
  };
  var handleEISDIR = needEISDIRHandled ? (path2, uid, gid, cb) => (er) => {
    if (!er || er.code !== "EISDIR")
      cb(er);
    else
      fs.chown(path2, uid, gid, cb);
  } : (_, __, ___, cb) => cb;
  var handleEISDirSync = needEISDIRHandled ? (path2, uid, gid) => {
    try {
      return lchownSync(path2, uid, gid);
    } catch (er) {
      if (er.code !== "EISDIR")
        throw er;
      chownSync(path2, uid, gid);
    }
  } : (path2, uid, gid) => lchownSync(path2, uid, gid);
  var nodeVersion = process.version;
  var readdir = (path2, options, cb) => fs.readdir(path2, options, cb);
  var readdirSync = (path2, options) => fs.readdirSync(path2, options);
  if (/^v4\./.test(nodeVersion))
    readdir = (path2, options, cb) => fs.readdir(path2, cb);
  var chown = (cpath, uid, gid, cb) => {
    fs[LCHOWN](cpath, uid, gid, handleEISDIR(cpath, uid, gid, (er) => {
      cb(er && er.code !== "ENOENT" ? er : null);
    }));
  };
  var chownrKid = (p, child, uid, gid, cb) => {
    if (typeof child === "string")
      return fs.lstat(path.resolve(p, child), (er, stats) => {
        if (er)
          return cb(er.code !== "ENOENT" ? er : null);
        stats.name = child;
        chownrKid(p, stats, uid, gid, cb);
      });
    if (child.isDirectory()) {
      chownr(path.resolve(p, child.name), uid, gid, (er) => {
        if (er)
          return cb(er);
        const cpath = path.resolve(p, child.name);
        chown(cpath, uid, gid, cb);
      });
    } else {
      const cpath = path.resolve(p, child.name);
      chown(cpath, uid, gid, cb);
    }
  };
  var chownr = (p, uid, gid, cb) => {
    readdir(p, { withFileTypes: true }, (er, children) => {
      if (er) {
        if (er.code === "ENOENT")
          return cb();
        else if (er.code !== "ENOTDIR" && er.code !== "ENOTSUP")
          return cb(er);
      }
      if (er || !children.length)
        return chown(p, uid, gid, cb);
      let len = children.length;
      let errState = null;
      const then = (er2) => {
        if (errState)
          return;
        if (er2)
          return cb(errState = er2);
        if (--len === 0)
          return chown(p, uid, gid, cb);
      };
      children.forEach((child) => chownrKid(p, child, uid, gid, then));
    });
  };
  var chownrKidSync = (p, child, uid, gid) => {
    if (typeof child === "string") {
      try {
        const stats = fs.lstatSync(path.resolve(p, child));
        stats.name = child;
        child = stats;
      } catch (er) {
        if (er.code === "ENOENT")
          return;
        else
          throw er;
      }
    }
    if (child.isDirectory())
      chownrSync(path.resolve(p, child.name), uid, gid);
    handleEISDirSync(path.resolve(p, child.name), uid, gid);
  };
  var chownrSync = (p, uid, gid) => {
    let children;
    try {
      children = readdirSync(p, { withFileTypes: true });
    } catch (er) {
      if (er.code === "ENOENT")
        return;
      else if (er.code === "ENOTDIR" || er.code === "ENOTSUP")
        return handleEISDirSync(p, uid, gid);
      else
        throw er;
    }
    if (children && children.length)
      children.forEach((child) => chownrKidSync(p, child, uid, gid));
    return handleEISDirSync(p, uid, gid);
  };
  module.exports = chownr;
  chownr.sync = chownrSync;
});

// ../../node_modules/tar/lib/mkdir.js
var require_mkdir = __commonJS((exports, module) => {
  var mkdirp = require_mkdirp();
  var fs = __require("fs");
  var path = __require("path");
  var chownr = require_chownr();
  var normPath = require_normalize_windows_path();

  class SymlinkError extends Error {
    constructor(symlink, path2) {
      super("Cannot extract through symbolic link");
      this.path = path2;
      this.symlink = symlink;
    }
    get name() {
      return "SylinkError";
    }
  }

  class CwdError extends Error {
    constructor(path2, code) {
      super(code + ": Cannot cd into '" + path2 + "'");
      this.path = path2;
      this.code = code;
    }
    get name() {
      return "CwdError";
    }
  }
  var cGet = (cache, key) => cache.get(normPath(key));
  var cSet = (cache, key, val) => cache.set(normPath(key), val);
  var checkCwd = (dir, cb) => {
    fs.stat(dir, (er, st) => {
      if (er || !st.isDirectory()) {
        er = new CwdError(dir, er && er.code || "ENOTDIR");
      }
      cb(er);
    });
  };
  module.exports = (dir, opt, cb) => {
    dir = normPath(dir);
    const umask = opt.umask;
    const mode = opt.mode | 448;
    const needChmod = (mode & umask) !== 0;
    const uid = opt.uid;
    const gid = opt.gid;
    const doChown = typeof uid === "number" && typeof gid === "number" && (uid !== opt.processUid || gid !== opt.processGid);
    const preserve = opt.preserve;
    const unlink = opt.unlink;
    const cache = opt.cache;
    const cwd = normPath(opt.cwd);
    const done = (er, created) => {
      if (er) {
        cb(er);
      } else {
        cSet(cache, dir, true);
        if (created && doChown) {
          chownr(created, uid, gid, (er2) => done(er2));
        } else if (needChmod) {
          fs.chmod(dir, mode, cb);
        } else {
          cb();
        }
      }
    };
    if (cache && cGet(cache, dir) === true) {
      return done();
    }
    if (dir === cwd) {
      return checkCwd(dir, done);
    }
    if (preserve) {
      return mkdirp(dir, { mode }).then((made) => done(null, made), done);
    }
    const sub = normPath(path.relative(cwd, dir));
    const parts = sub.split("/");
    mkdir_(cwd, parts, mode, cache, unlink, cwd, null, done);
  };
  var mkdir_ = (base, parts, mode, cache, unlink, cwd, created, cb) => {
    if (!parts.length) {
      return cb(null, created);
    }
    const p = parts.shift();
    const part = normPath(path.resolve(base + "/" + p));
    if (cGet(cache, part)) {
      return mkdir_(part, parts, mode, cache, unlink, cwd, created, cb);
    }
    fs.mkdir(part, mode, onmkdir(part, parts, mode, cache, unlink, cwd, created, cb));
  };
  var onmkdir = (part, parts, mode, cache, unlink, cwd, created, cb) => (er) => {
    if (er) {
      fs.lstat(part, (statEr, st) => {
        if (statEr) {
          statEr.path = statEr.path && normPath(statEr.path);
          cb(statEr);
        } else if (st.isDirectory()) {
          mkdir_(part, parts, mode, cache, unlink, cwd, created, cb);
        } else if (unlink) {
          fs.unlink(part, (er2) => {
            if (er2) {
              return cb(er2);
            }
            fs.mkdir(part, mode, onmkdir(part, parts, mode, cache, unlink, cwd, created, cb));
          });
        } else if (st.isSymbolicLink()) {
          return cb(new SymlinkError(part, part + "/" + parts.join("/")));
        } else {
          cb(er);
        }
      });
    } else {
      created = created || part;
      mkdir_(part, parts, mode, cache, unlink, cwd, created, cb);
    }
  };
  var checkCwdSync = (dir) => {
    let ok = false;
    let code = "ENOTDIR";
    try {
      ok = fs.statSync(dir).isDirectory();
    } catch (er) {
      code = er.code;
    } finally {
      if (!ok) {
        throw new CwdError(dir, code);
      }
    }
  };
  module.exports.sync = (dir, opt) => {
    dir = normPath(dir);
    const umask = opt.umask;
    const mode = opt.mode | 448;
    const needChmod = (mode & umask) !== 0;
    const uid = opt.uid;
    const gid = opt.gid;
    const doChown = typeof uid === "number" && typeof gid === "number" && (uid !== opt.processUid || gid !== opt.processGid);
    const preserve = opt.preserve;
    const unlink = opt.unlink;
    const cache = opt.cache;
    const cwd = normPath(opt.cwd);
    const done = (created2) => {
      cSet(cache, dir, true);
      if (created2 && doChown) {
        chownr.sync(created2, uid, gid);
      }
      if (needChmod) {
        fs.chmodSync(dir, mode);
      }
    };
    if (cache && cGet(cache, dir) === true) {
      return done();
    }
    if (dir === cwd) {
      checkCwdSync(cwd);
      return done();
    }
    if (preserve) {
      return done(mkdirp.sync(dir, mode));
    }
    const sub = normPath(path.relative(cwd, dir));
    const parts = sub.split("/");
    let created = null;
    for (let p = parts.shift(), part = cwd;p && (part += "/" + p); p = parts.shift()) {
      part = normPath(path.resolve(part));
      if (cGet(cache, part)) {
        continue;
      }
      try {
        fs.mkdirSync(part, mode);
        created = created || part;
        cSet(cache, part, true);
      } catch (er) {
        const st = fs.lstatSync(part);
        if (st.isDirectory()) {
          cSet(cache, part, true);
          continue;
        } else if (unlink) {
          fs.unlinkSync(part);
          fs.mkdirSync(part, mode);
          created = created || part;
          cSet(cache, part, true);
          continue;
        } else if (st.isSymbolicLink()) {
          return new SymlinkError(part, part + "/" + parts.join("/"));
        }
      }
    }
    return done(created);
  };
});

// ../../node_modules/tar/lib/normalize-unicode.js
var require_normalize_unicode = __commonJS((exports, module) => {
  var normalizeCache = Object.create(null);
  var { hasOwnProperty } = Object.prototype;
  module.exports = (s) => {
    if (!hasOwnProperty.call(normalizeCache, s)) {
      normalizeCache[s] = s.normalize("NFD");
    }
    return normalizeCache[s];
  };
});

// ../../node_modules/tar/lib/path-reservations.js
var require_path_reservations = __commonJS((exports, module) => {
  var assert = __require("assert");
  var normalize = require_normalize_unicode();
  var stripSlashes = require_strip_trailing_slashes();
  var { join } = __require("path");
  var platform = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
  var isWindows = platform === "win32";
  module.exports = () => {
    const queues = new Map;
    const reservations = new Map;
    const getDirs = (path) => {
      const dirs = path.split("/").slice(0, -1).reduce((set, path2) => {
        if (set.length) {
          path2 = join(set[set.length - 1], path2);
        }
        set.push(path2 || "/");
        return set;
      }, []);
      return dirs;
    };
    const running = new Set;
    const getQueues = (fn) => {
      const res = reservations.get(fn);
      if (!res) {
        throw new Error("function does not have any path reservations");
      }
      return {
        paths: res.paths.map((path) => queues.get(path)),
        dirs: [...res.dirs].map((path) => queues.get(path))
      };
    };
    const check = (fn) => {
      const { paths, dirs } = getQueues(fn);
      return paths.every((q) => q[0] === fn) && dirs.every((q) => q[0] instanceof Set && q[0].has(fn));
    };
    const run = (fn) => {
      if (running.has(fn) || !check(fn)) {
        return false;
      }
      running.add(fn);
      fn(() => clear(fn));
      return true;
    };
    const clear = (fn) => {
      if (!running.has(fn)) {
        return false;
      }
      const { paths, dirs } = reservations.get(fn);
      const next = new Set;
      paths.forEach((path) => {
        const q = queues.get(path);
        assert.equal(q[0], fn);
        if (q.length === 1) {
          queues.delete(path);
        } else {
          q.shift();
          if (typeof q[0] === "function") {
            next.add(q[0]);
          } else {
            q[0].forEach((fn2) => next.add(fn2));
          }
        }
      });
      dirs.forEach((dir) => {
        const q = queues.get(dir);
        assert(q[0] instanceof Set);
        if (q[0].size === 1 && q.length === 1) {
          queues.delete(dir);
        } else if (q[0].size === 1) {
          q.shift();
          next.add(q[0]);
        } else {
          q[0].delete(fn);
        }
      });
      running.delete(fn);
      next.forEach((fn2) => run(fn2));
      return true;
    };
    const reserve = (paths, fn) => {
      paths = isWindows ? ["win32 parallelization disabled"] : paths.map((p) => {
        return stripSlashes(join(normalize(p))).toLowerCase();
      });
      const dirs = new Set(paths.map((path) => getDirs(path)).reduce((a, b) => a.concat(b)));
      reservations.set(fn, { dirs, paths });
      paths.forEach((path) => {
        const q = queues.get(path);
        if (!q) {
          queues.set(path, [fn]);
        } else {
          q.push(fn);
        }
      });
      dirs.forEach((dir) => {
        const q = queues.get(dir);
        if (!q) {
          queues.set(dir, [new Set([fn])]);
        } else if (q[q.length - 1] instanceof Set) {
          q[q.length - 1].add(fn);
        } else {
          q.push(new Set([fn]));
        }
      });
      return run(fn);
    };
    return { check, reserve };
  };
});

// ../../node_modules/tar/lib/get-write-flag.js
var require_get_write_flag = __commonJS((exports, module) => {
  var platform = process.env.__FAKE_PLATFORM__ || process.platform;
  var isWindows = platform === "win32";
  var fs = global.__FAKE_TESTING_FS__ || __require("fs");
  var { O_CREAT, O_TRUNC, O_WRONLY, UV_FS_O_FILEMAP = 0 } = fs.constants;
  var fMapEnabled = isWindows && !!UV_FS_O_FILEMAP;
  var fMapLimit = 512 * 1024;
  var fMapFlag = UV_FS_O_FILEMAP | O_TRUNC | O_CREAT | O_WRONLY;
  module.exports = !fMapEnabled ? () => "w" : (size) => size < fMapLimit ? fMapFlag : "w";
});

// ../../node_modules/tar/lib/unpack.js
var require_unpack = __commonJS((exports, module) => {
  var assert = __require("assert");
  var Parser = require_parse();
  var fs = __require("fs");
  var fsm = require_fs_minipass();
  var path = __require("path");
  var mkdir = require_mkdir();
  var wc = require_winchars();
  var pathReservations = require_path_reservations();
  var stripAbsolutePath = require_strip_absolute_path();
  var normPath = require_normalize_windows_path();
  var stripSlash = require_strip_trailing_slashes();
  var normalize = require_normalize_unicode();
  var ONENTRY = Symbol("onEntry");
  var CHECKFS = Symbol("checkFs");
  var CHECKFS2 = Symbol("checkFs2");
  var PRUNECACHE = Symbol("pruneCache");
  var ISREUSABLE = Symbol("isReusable");
  var MAKEFS = Symbol("makeFs");
  var FILE = Symbol("file");
  var DIRECTORY = Symbol("directory");
  var LINK = Symbol("link");
  var SYMLINK = Symbol("symlink");
  var HARDLINK = Symbol("hardlink");
  var UNSUPPORTED = Symbol("unsupported");
  var CHECKPATH = Symbol("checkPath");
  var MKDIR = Symbol("mkdir");
  var ONERROR = Symbol("onError");
  var PENDING = Symbol("pending");
  var PEND = Symbol("pend");
  var UNPEND = Symbol("unpend");
  var ENDED = Symbol("ended");
  var MAYBECLOSE = Symbol("maybeClose");
  var SKIP = Symbol("skip");
  var DOCHOWN = Symbol("doChown");
  var UID = Symbol("uid");
  var GID = Symbol("gid");
  var CHECKED_CWD = Symbol("checkedCwd");
  var crypto = __require("crypto");
  var getFlag = require_get_write_flag();
  var platform = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
  var isWindows = platform === "win32";
  var DEFAULT_MAX_DEPTH = 1024;
  var unlinkFile = (path2, cb) => {
    if (!isWindows) {
      return fs.unlink(path2, cb);
    }
    const name = path2 + ".DELETE." + crypto.randomBytes(16).toString("hex");
    fs.rename(path2, name, (er) => {
      if (er) {
        return cb(er);
      }
      fs.unlink(name, cb);
    });
  };
  var unlinkFileSync = (path2) => {
    if (!isWindows) {
      return fs.unlinkSync(path2);
    }
    const name = path2 + ".DELETE." + crypto.randomBytes(16).toString("hex");
    fs.renameSync(path2, name);
    fs.unlinkSync(name);
  };
  var uint32 = (a, b, c) => a === a >>> 0 ? a : b === b >>> 0 ? b : c;
  var cacheKeyNormalize = (path2) => stripSlash(normPath(normalize(path2))).toLowerCase();
  var pruneCache = (cache, abs) => {
    abs = cacheKeyNormalize(abs);
    for (const path2 of cache.keys()) {
      const pnorm = cacheKeyNormalize(path2);
      if (pnorm === abs || pnorm.indexOf(abs + "/") === 0) {
        cache.delete(path2);
      }
    }
  };
  var dropCache = (cache) => {
    for (const key of cache.keys()) {
      cache.delete(key);
    }
  };

  class Unpack extends Parser {
    constructor(opt) {
      if (!opt) {
        opt = {};
      }
      opt.ondone = (_) => {
        this[ENDED] = true;
        this[MAYBECLOSE]();
      };
      super(opt);
      this[CHECKED_CWD] = false;
      this.reservations = pathReservations();
      this.transform = typeof opt.transform === "function" ? opt.transform : null;
      this.writable = true;
      this.readable = false;
      this[PENDING] = 0;
      this[ENDED] = false;
      this.dirCache = opt.dirCache || new Map;
      if (typeof opt.uid === "number" || typeof opt.gid === "number") {
        if (typeof opt.uid !== "number" || typeof opt.gid !== "number") {
          throw new TypeError("cannot set owner without number uid and gid");
        }
        if (opt.preserveOwner) {
          throw new TypeError("cannot preserve owner in archive and also set owner explicitly");
        }
        this.uid = opt.uid;
        this.gid = opt.gid;
        this.setOwner = true;
      } else {
        this.uid = null;
        this.gid = null;
        this.setOwner = false;
      }
      if (opt.preserveOwner === undefined && typeof opt.uid !== "number") {
        this.preserveOwner = process.getuid && process.getuid() === 0;
      } else {
        this.preserveOwner = !!opt.preserveOwner;
      }
      this.processUid = (this.preserveOwner || this.setOwner) && process.getuid ? process.getuid() : null;
      this.processGid = (this.preserveOwner || this.setOwner) && process.getgid ? process.getgid() : null;
      this.maxDepth = typeof opt.maxDepth === "number" ? opt.maxDepth : DEFAULT_MAX_DEPTH;
      this.forceChown = opt.forceChown === true;
      this.win32 = !!opt.win32 || isWindows;
      this.newer = !!opt.newer;
      this.keep = !!opt.keep;
      this.noMtime = !!opt.noMtime;
      this.preservePaths = !!opt.preservePaths;
      this.unlink = !!opt.unlink;
      this.cwd = normPath(path.resolve(opt.cwd || process.cwd()));
      this.strip = +opt.strip || 0;
      this.processUmask = opt.noChmod ? 0 : process.umask();
      this.umask = typeof opt.umask === "number" ? opt.umask : this.processUmask;
      this.dmode = opt.dmode || 511 & ~this.umask;
      this.fmode = opt.fmode || 438 & ~this.umask;
      this.on("entry", (entry) => this[ONENTRY](entry));
    }
    warn(code, msg, data = {}) {
      if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ABORT") {
        data.recoverable = false;
      }
      return super.warn(code, msg, data);
    }
    [MAYBECLOSE]() {
      if (this[ENDED] && this[PENDING] === 0) {
        this.emit("prefinish");
        this.emit("finish");
        this.emit("end");
      }
    }
    [CHECKPATH](entry) {
      const p = normPath(entry.path);
      const parts = p.split("/");
      if (this.strip) {
        if (parts.length < this.strip) {
          return false;
        }
        if (entry.type === "Link") {
          const linkparts = normPath(entry.linkpath).split("/");
          if (linkparts.length >= this.strip) {
            entry.linkpath = linkparts.slice(this.strip).join("/");
          } else {
            return false;
          }
        }
        parts.splice(0, this.strip);
        entry.path = parts.join("/");
      }
      if (isFinite(this.maxDepth) && parts.length > this.maxDepth) {
        this.warn("TAR_ENTRY_ERROR", "path excessively deep", {
          entry,
          path: p,
          depth: parts.length,
          maxDepth: this.maxDepth
        });
        return false;
      }
      if (!this.preservePaths) {
        if (parts.includes("..") || isWindows && /^[a-z]:\.\.$/i.test(parts[0])) {
          this.warn("TAR_ENTRY_ERROR", `path contains '..'`, {
            entry,
            path: p
          });
          return false;
        }
        const [root, stripped] = stripAbsolutePath(p);
        if (root) {
          entry.path = stripped;
          this.warn("TAR_ENTRY_INFO", `stripping ${root} from absolute path`, {
            entry,
            path: p
          });
        }
      }
      if (path.isAbsolute(entry.path)) {
        entry.absolute = normPath(path.resolve(entry.path));
      } else {
        entry.absolute = normPath(path.resolve(this.cwd, entry.path));
      }
      if (!this.preservePaths && entry.absolute.indexOf(this.cwd + "/") !== 0 && entry.absolute !== this.cwd) {
        this.warn("TAR_ENTRY_ERROR", "path escaped extraction target", {
          entry,
          path: normPath(entry.path),
          resolvedPath: entry.absolute,
          cwd: this.cwd
        });
        return false;
      }
      if (entry.absolute === this.cwd && entry.type !== "Directory" && entry.type !== "GNUDumpDir") {
        return false;
      }
      if (this.win32) {
        const { root: aRoot } = path.win32.parse(entry.absolute);
        entry.absolute = aRoot + wc.encode(entry.absolute.slice(aRoot.length));
        const { root: pRoot } = path.win32.parse(entry.path);
        entry.path = pRoot + wc.encode(entry.path.slice(pRoot.length));
      }
      return true;
    }
    [ONENTRY](entry) {
      if (!this[CHECKPATH](entry)) {
        return entry.resume();
      }
      assert.equal(typeof entry.absolute, "string");
      switch (entry.type) {
        case "Directory":
        case "GNUDumpDir":
          if (entry.mode) {
            entry.mode = entry.mode | 448;
          }
        case "File":
        case "OldFile":
        case "ContiguousFile":
        case "Link":
        case "SymbolicLink":
          return this[CHECKFS](entry);
        case "CharacterDevice":
        case "BlockDevice":
        case "FIFO":
        default:
          return this[UNSUPPORTED](entry);
      }
    }
    [ONERROR](er, entry) {
      if (er.name === "CwdError") {
        this.emit("error", er);
      } else {
        this.warn("TAR_ENTRY_ERROR", er, { entry });
        this[UNPEND]();
        entry.resume();
      }
    }
    [MKDIR](dir, mode, cb) {
      mkdir(normPath(dir), {
        uid: this.uid,
        gid: this.gid,
        processUid: this.processUid,
        processGid: this.processGid,
        umask: this.processUmask,
        preserve: this.preservePaths,
        unlink: this.unlink,
        cache: this.dirCache,
        cwd: this.cwd,
        mode,
        noChmod: this.noChmod
      }, cb);
    }
    [DOCHOWN](entry) {
      return this.forceChown || this.preserveOwner && (typeof entry.uid === "number" && entry.uid !== this.processUid || typeof entry.gid === "number" && entry.gid !== this.processGid) || (typeof this.uid === "number" && this.uid !== this.processUid || typeof this.gid === "number" && this.gid !== this.processGid);
    }
    [UID](entry) {
      return uint32(this.uid, entry.uid, this.processUid);
    }
    [GID](entry) {
      return uint32(this.gid, entry.gid, this.processGid);
    }
    [FILE](entry, fullyDone) {
      const mode = entry.mode & 4095 || this.fmode;
      const stream = new fsm.WriteStream(entry.absolute, {
        flags: getFlag(entry.size),
        mode,
        autoClose: false
      });
      stream.on("error", (er) => {
        if (stream.fd) {
          fs.close(stream.fd, () => {});
        }
        stream.write = () => true;
        this[ONERROR](er, entry);
        fullyDone();
      });
      let actions = 1;
      const done = (er) => {
        if (er) {
          if (stream.fd) {
            fs.close(stream.fd, () => {});
          }
          this[ONERROR](er, entry);
          fullyDone();
          return;
        }
        if (--actions === 0) {
          fs.close(stream.fd, (er2) => {
            if (er2) {
              this[ONERROR](er2, entry);
            } else {
              this[UNPEND]();
            }
            fullyDone();
          });
        }
      };
      stream.on("finish", (_) => {
        const abs = entry.absolute;
        const fd = stream.fd;
        if (entry.mtime && !this.noMtime) {
          actions++;
          const atime = entry.atime || new Date;
          const mtime = entry.mtime;
          fs.futimes(fd, atime, mtime, (er) => er ? fs.utimes(abs, atime, mtime, (er2) => done(er2 && er)) : done());
        }
        if (this[DOCHOWN](entry)) {
          actions++;
          const uid = this[UID](entry);
          const gid = this[GID](entry);
          fs.fchown(fd, uid, gid, (er) => er ? fs.chown(abs, uid, gid, (er2) => done(er2 && er)) : done());
        }
        done();
      });
      const tx = this.transform ? this.transform(entry) || entry : entry;
      if (tx !== entry) {
        tx.on("error", (er) => {
          this[ONERROR](er, entry);
          fullyDone();
        });
        entry.pipe(tx);
      }
      tx.pipe(stream);
    }
    [DIRECTORY](entry, fullyDone) {
      const mode = entry.mode & 4095 || this.dmode;
      this[MKDIR](entry.absolute, mode, (er) => {
        if (er) {
          this[ONERROR](er, entry);
          fullyDone();
          return;
        }
        let actions = 1;
        const done = (_) => {
          if (--actions === 0) {
            fullyDone();
            this[UNPEND]();
            entry.resume();
          }
        };
        if (entry.mtime && !this.noMtime) {
          actions++;
          fs.utimes(entry.absolute, entry.atime || new Date, entry.mtime, done);
        }
        if (this[DOCHOWN](entry)) {
          actions++;
          fs.chown(entry.absolute, this[UID](entry), this[GID](entry), done);
        }
        done();
      });
    }
    [UNSUPPORTED](entry) {
      entry.unsupported = true;
      this.warn("TAR_ENTRY_UNSUPPORTED", `unsupported entry type: ${entry.type}`, { entry });
      entry.resume();
    }
    [SYMLINK](entry, done) {
      this[LINK](entry, entry.linkpath, "symlink", done);
    }
    [HARDLINK](entry, done) {
      const linkpath = normPath(path.resolve(this.cwd, entry.linkpath));
      this[LINK](entry, linkpath, "link", done);
    }
    [PEND]() {
      this[PENDING]++;
    }
    [UNPEND]() {
      this[PENDING]--;
      this[MAYBECLOSE]();
    }
    [SKIP](entry) {
      this[UNPEND]();
      entry.resume();
    }
    [ISREUSABLE](entry, st) {
      return entry.type === "File" && !this.unlink && st.isFile() && st.nlink <= 1 && !isWindows;
    }
    [CHECKFS](entry) {
      this[PEND]();
      const paths = [entry.path];
      if (entry.linkpath) {
        paths.push(entry.linkpath);
      }
      this.reservations.reserve(paths, (done) => this[CHECKFS2](entry, done));
    }
    [PRUNECACHE](entry) {
      if (entry.type === "SymbolicLink") {
        dropCache(this.dirCache);
      } else if (entry.type !== "Directory") {
        pruneCache(this.dirCache, entry.absolute);
      }
    }
    [CHECKFS2](entry, fullyDone) {
      this[PRUNECACHE](entry);
      const done = (er) => {
        this[PRUNECACHE](entry);
        fullyDone(er);
      };
      const checkCwd = () => {
        this[MKDIR](this.cwd, this.dmode, (er) => {
          if (er) {
            this[ONERROR](er, entry);
            done();
            return;
          }
          this[CHECKED_CWD] = true;
          start();
        });
      };
      const start = () => {
        if (entry.absolute !== this.cwd) {
          const parent = normPath(path.dirname(entry.absolute));
          if (parent !== this.cwd) {
            return this[MKDIR](parent, this.dmode, (er) => {
              if (er) {
                this[ONERROR](er, entry);
                done();
                return;
              }
              afterMakeParent();
            });
          }
        }
        afterMakeParent();
      };
      const afterMakeParent = () => {
        fs.lstat(entry.absolute, (lstatEr, st) => {
          if (st && (this.keep || this.newer && st.mtime > entry.mtime)) {
            this[SKIP](entry);
            done();
            return;
          }
          if (lstatEr || this[ISREUSABLE](entry, st)) {
            return this[MAKEFS](null, entry, done);
          }
          if (st.isDirectory()) {
            if (entry.type === "Directory") {
              const needChmod = !this.noChmod && entry.mode && (st.mode & 4095) !== entry.mode;
              const afterChmod = (er) => this[MAKEFS](er, entry, done);
              if (!needChmod) {
                return afterChmod();
              }
              return fs.chmod(entry.absolute, entry.mode, afterChmod);
            }
            if (entry.absolute !== this.cwd) {
              return fs.rmdir(entry.absolute, (er) => this[MAKEFS](er, entry, done));
            }
          }
          if (entry.absolute === this.cwd) {
            return this[MAKEFS](null, entry, done);
          }
          unlinkFile(entry.absolute, (er) => this[MAKEFS](er, entry, done));
        });
      };
      if (this[CHECKED_CWD]) {
        start();
      } else {
        checkCwd();
      }
    }
    [MAKEFS](er, entry, done) {
      if (er) {
        this[ONERROR](er, entry);
        done();
        return;
      }
      switch (entry.type) {
        case "File":
        case "OldFile":
        case "ContiguousFile":
          return this[FILE](entry, done);
        case "Link":
          return this[HARDLINK](entry, done);
        case "SymbolicLink":
          return this[SYMLINK](entry, done);
        case "Directory":
        case "GNUDumpDir":
          return this[DIRECTORY](entry, done);
      }
    }
    [LINK](entry, linkpath, link, done) {
      fs[link](linkpath, entry.absolute, (er) => {
        if (er) {
          this[ONERROR](er, entry);
        } else {
          this[UNPEND]();
          entry.resume();
        }
        done();
      });
    }
  }
  var callSync = (fn) => {
    try {
      return [null, fn()];
    } catch (er) {
      return [er, null];
    }
  };

  class UnpackSync extends Unpack {
    [MAKEFS](er, entry) {
      return super[MAKEFS](er, entry, () => {});
    }
    [CHECKFS](entry) {
      this[PRUNECACHE](entry);
      if (!this[CHECKED_CWD]) {
        const er2 = this[MKDIR](this.cwd, this.dmode);
        if (er2) {
          return this[ONERROR](er2, entry);
        }
        this[CHECKED_CWD] = true;
      }
      if (entry.absolute !== this.cwd) {
        const parent = normPath(path.dirname(entry.absolute));
        if (parent !== this.cwd) {
          const mkParent = this[MKDIR](parent, this.dmode);
          if (mkParent) {
            return this[ONERROR](mkParent, entry);
          }
        }
      }
      const [lstatEr, st] = callSync(() => fs.lstatSync(entry.absolute));
      if (st && (this.keep || this.newer && st.mtime > entry.mtime)) {
        return this[SKIP](entry);
      }
      if (lstatEr || this[ISREUSABLE](entry, st)) {
        return this[MAKEFS](null, entry);
      }
      if (st.isDirectory()) {
        if (entry.type === "Directory") {
          const needChmod = !this.noChmod && entry.mode && (st.mode & 4095) !== entry.mode;
          const [er3] = needChmod ? callSync(() => {
            fs.chmodSync(entry.absolute, entry.mode);
          }) : [];
          return this[MAKEFS](er3, entry);
        }
        const [er2] = callSync(() => fs.rmdirSync(entry.absolute));
        this[MAKEFS](er2, entry);
      }
      const [er] = entry.absolute === this.cwd ? [] : callSync(() => unlinkFileSync(entry.absolute));
      this[MAKEFS](er, entry);
    }
    [FILE](entry, done) {
      const mode = entry.mode & 4095 || this.fmode;
      const oner = (er) => {
        let closeError;
        try {
          fs.closeSync(fd);
        } catch (e) {
          closeError = e;
        }
        if (er || closeError) {
          this[ONERROR](er || closeError, entry);
        }
        done();
      };
      let fd;
      try {
        fd = fs.openSync(entry.absolute, getFlag(entry.size), mode);
      } catch (er) {
        return oner(er);
      }
      const tx = this.transform ? this.transform(entry) || entry : entry;
      if (tx !== entry) {
        tx.on("error", (er) => this[ONERROR](er, entry));
        entry.pipe(tx);
      }
      tx.on("data", (chunk) => {
        try {
          fs.writeSync(fd, chunk, 0, chunk.length);
        } catch (er) {
          oner(er);
        }
      });
      tx.on("end", (_) => {
        let er = null;
        if (entry.mtime && !this.noMtime) {
          const atime = entry.atime || new Date;
          const mtime = entry.mtime;
          try {
            fs.futimesSync(fd, atime, mtime);
          } catch (futimeser) {
            try {
              fs.utimesSync(entry.absolute, atime, mtime);
            } catch (utimeser) {
              er = futimeser;
            }
          }
        }
        if (this[DOCHOWN](entry)) {
          const uid = this[UID](entry);
          const gid = this[GID](entry);
          try {
            fs.fchownSync(fd, uid, gid);
          } catch (fchowner) {
            try {
              fs.chownSync(entry.absolute, uid, gid);
            } catch (chowner) {
              er = er || fchowner;
            }
          }
        }
        oner(er);
      });
    }
    [DIRECTORY](entry, done) {
      const mode = entry.mode & 4095 || this.dmode;
      const er = this[MKDIR](entry.absolute, mode);
      if (er) {
        this[ONERROR](er, entry);
        done();
        return;
      }
      if (entry.mtime && !this.noMtime) {
        try {
          fs.utimesSync(entry.absolute, entry.atime || new Date, entry.mtime);
        } catch (er2) {}
      }
      if (this[DOCHOWN](entry)) {
        try {
          fs.chownSync(entry.absolute, this[UID](entry), this[GID](entry));
        } catch (er2) {}
      }
      done();
      entry.resume();
    }
    [MKDIR](dir, mode) {
      try {
        return mkdir.sync(normPath(dir), {
          uid: this.uid,
          gid: this.gid,
          processUid: this.processUid,
          processGid: this.processGid,
          umask: this.processUmask,
          preserve: this.preservePaths,
          unlink: this.unlink,
          cache: this.dirCache,
          cwd: this.cwd,
          mode
        });
      } catch (er) {
        return er;
      }
    }
    [LINK](entry, linkpath, link, done) {
      try {
        fs[link + "Sync"](linkpath, entry.absolute);
        done();
        entry.resume();
      } catch (er) {
        return this[ONERROR](er, entry);
      }
    }
  }
  Unpack.Sync = UnpackSync;
  module.exports = Unpack;
});

// ../../node_modules/tar/lib/extract.js
var require_extract = __commonJS((exports, module) => {
  var hlo = require_high_level_opt();
  var Unpack = require_unpack();
  var fs = __require("fs");
  var fsm = require_fs_minipass();
  var path = __require("path");
  var stripSlash = require_strip_trailing_slashes();
  module.exports = (opt_, files, cb) => {
    if (typeof opt_ === "function") {
      cb = opt_, files = null, opt_ = {};
    } else if (Array.isArray(opt_)) {
      files = opt_, opt_ = {};
    }
    if (typeof files === "function") {
      cb = files, files = null;
    }
    if (!files) {
      files = [];
    } else {
      files = Array.from(files);
    }
    const opt = hlo(opt_);
    if (opt.sync && typeof cb === "function") {
      throw new TypeError("callback not supported for sync tar functions");
    }
    if (!opt.file && typeof cb === "function") {
      throw new TypeError("callback only supported with file option");
    }
    if (files.length) {
      filesFilter(opt, files);
    }
    return opt.file && opt.sync ? extractFileSync(opt) : opt.file ? extractFile(opt, cb) : opt.sync ? extractSync(opt) : extract(opt);
  };
  var filesFilter = (opt, files) => {
    const map = new Map(files.map((f) => [stripSlash(f), true]));
    const filter = opt.filter;
    const mapHas = (file, r) => {
      const root = r || path.parse(file).root || ".";
      const ret = file === root ? false : map.has(file) ? map.get(file) : mapHas(path.dirname(file), root);
      map.set(file, ret);
      return ret;
    };
    opt.filter = filter ? (file, entry) => filter(file, entry) && mapHas(stripSlash(file)) : (file) => mapHas(stripSlash(file));
  };
  var extractFileSync = (opt) => {
    const u = new Unpack.Sync(opt);
    const file = opt.file;
    const stat = fs.statSync(file);
    const readSize = opt.maxReadSize || 16 * 1024 * 1024;
    const stream = new fsm.ReadStreamSync(file, {
      readSize,
      size: stat.size
    });
    stream.pipe(u);
  };
  var extractFile = (opt, cb) => {
    const u = new Unpack(opt);
    const readSize = opt.maxReadSize || 16 * 1024 * 1024;
    const file = opt.file;
    const p = new Promise((resolve, reject) => {
      u.on("error", reject);
      u.on("close", resolve);
      fs.stat(file, (er, stat) => {
        if (er) {
          reject(er);
        } else {
          const stream = new fsm.ReadStream(file, {
            readSize,
            size: stat.size
          });
          stream.on("error", reject);
          stream.pipe(u);
        }
      });
    });
    return cb ? p.then(cb, cb) : p;
  };
  var extractSync = (opt) => new Unpack.Sync(opt);
  var extract = (opt) => new Unpack(opt);
});

// ../../node_modules/tar/index.js
var require_tar = __commonJS((exports) => {
  exports.c = exports.create = require_create();
  exports.r = exports.replace = require_replace();
  exports.t = exports.list = require_list();
  exports.u = exports.update = require_update();
  exports.x = exports.extract = require_extract();
  exports.Pack = require_pack();
  exports.Unpack = require_unpack();
  exports.Parse = require_parse();
  exports.ReadEntry = require_read_entry();
  exports.WriteEntry = require_write_entry();
  exports.Header = require_header();
  exports.Pax = require_pax();
  exports.types = require_types();
});

// src/main.ts
import { app, BrowserWindow, Tray, Menu, shell } from "electron";
import { join as join2, dirname as dirname2 } from "node:path";
import { existsSync as existsSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { spawn as spawn2 } from "node:child_process";
// ../lib/src/logger.ts
var REDACT_PATTERN = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|HMAC)(?:_|$)/i;
function isSensitiveEnvKey(key) {
  return REDACT_PATTERN.test(key);
}
function redactExtra(extra) {
  if (extra == null || typeof extra !== "object")
    return extra;
  if (Array.isArray(extra)) {
    return extra.map((v) => v && typeof v === "object" ? redactExtra(v) : v);
  }
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (isSensitiveEnvKey(k)) {
      if (v && typeof v === "object") {
        out[k] = redactExtra(v);
      } else if (v == null) {
        out[k] = v;
      } else {
        out[k] = "***REDACTED***";
      }
    } else if (v && typeof v === "object") {
      out[k] = redactExtra(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function createLogger(service) {
  function log(level, msg, extra) {
    const safeExtra = extra ? redactExtra(extra) : undefined;
    const entry = { ts: new Date().toISOString(), level, service, msg, ...safeExtra ? { extra: safeExtra } : {} };
    (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(entry));
  }
  return {
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
    debug: (msg, extra) => log("debug", msg, extra)
  };
}
// ../../node_modules/yaml/dist/index.js
var composer = require_composer();
var Document = require_Document();
var Schema = require_Schema();
var errors = require_errors();
var Alias = require_Alias();
var identity = require_identity();
var Pair = require_Pair();
var Scalar = require_Scalar();
var YAMLMap = require_YAMLMap();
var YAMLSeq = require_YAMLSeq();
var cst = require_cst();
var lexer = require_lexer();
var lineCounter = require_line_counter();
var parser = require_parser();
var publicApi = require_public_api();
var visit = require_visit();
var $Composer = composer.Composer;
var $Document = Document.Document;
var $Schema = Schema.Schema;
var $YAMLError = errors.YAMLError;
var $YAMLParseError = errors.YAMLParseError;
var $YAMLWarning = errors.YAMLWarning;
var $Alias = Alias.Alias;
var $isAlias = identity.isAlias;
var $isCollection = identity.isCollection;
var $isDocument = identity.isDocument;
var $isMap = identity.isMap;
var $isNode = identity.isNode;
var $isPair = identity.isPair;
var $isScalar = identity.isScalar;
var $isSeq = identity.isSeq;
var $Pair = Pair.Pair;
var $Scalar = Scalar.Scalar;
var $YAMLMap = YAMLMap.YAMLMap;
var $YAMLSeq = YAMLSeq.YAMLSeq;
var $Lexer = lexer.Lexer;
var $LineCounter = lineCounter.LineCounter;
var $Parser = parser.Parser;
var $parse = publicApi.parse;
var $parseAllDocuments = publicApi.parseAllDocuments;
var $parseDocument = publicApi.parseDocument;
var $stringify = publicApi.stringify;
var $visit = visit.visit;
var $visitAsync = visit.visitAsync;

// ../lib/src/control-plane/env.ts
var import_dotenv = __toESM(require_main(), 1);

// ../lib/src/control-plane/home.ts
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
function resolveHome() {
  const home = homedir();
  if (home)
    return home;
  return tmpdir();
}
function resolveOpenPalmHome() {
  const raw = process.env.OP_HOME;
  if (raw)
    return resolvePath(raw);
  return `${resolveHome()}/.openpalm`;
}
function resolveConfigDir() {
  return `${resolveOpenPalmHome()}/config`;
}
function resolveStateDir() {
  return `${resolveOpenPalmHome()}/state`;
}
function ensureHomeDirs() {
  const home = resolveOpenPalmHome();
  for (const dir of [
    `${home}/config`,
    `${home}/config/assistant`,
    `${home}/config/guardian`,
    `${home}/config/akm`,
    `${home}/cache`,
    `${home}/cache/akm`,
    `${home}/cache/rollback`,
    `${home}/state`,
    `${home}/state/assistant`,
    `${home}/state/admin`,
    `${home}/state/guardian`,
    `${home}/state/akm`,
    `${home}/state/akm/data`,
    `${home}/state/akm/state`,
    `${home}/state/logs`,
    `${home}/state/logs/opencode`,
    `${home}/state/backups`,
    `${home}/state/registry`,
    `${home}/state/registry/addons`,
    `${home}/state/registry/automations`,
    `${home}/stash`,
    `${home}/stash/vaults`,
    `${home}/stash/tasks`,
    `${home}/workspace`,
    `${home}/config/stack`,
    `${home}/config/stack/addons`
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

// ../lib/src/control-plane/core-assets.ts
var logger = createLogger("core-assets");
var VERSION = process.env.OP_ASSET_VERSION ?? "main";
// ../lib/src/control-plane/config-persistence.ts
var DEFAULT_IMAGE_TAG = process.env.OP_IMAGE_TAG ?? "latest";

// ../lib/src/control-plane/registry.ts
var logger2 = createLogger("registry");
// ../lib/src/control-plane/secrets.ts
var OPENCODE_STARTER_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + `
`;
var logger3 = createLogger("secrets");
var PLAIN_CONFIG_KEYS = new Set([
  "OPENAI_BASE_URL",
  "OWNER_NAME",
  "OWNER_EMAIL"
]);
// ../lib/src/control-plane/secret-backend.ts
import { execFile as execFileCb2, spawn } from "node:child_process";
import { promisify as promisify2 } from "node:util";

// ../lib/src/control-plane/akm-vault.ts
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
var execFile = promisify(execFileCb);
var logger4 = createLogger("akm-vault");

// ../lib/src/control-plane/secret-backend.ts
var execFile2 = promisify2(execFileCb2);
// ../lib/src/control-plane/docker.ts
var logger5 = createLogger("lib:docker");

// ../lib/src/control-plane/lifecycle.ts
var VALID_CALLERS = new Set([
  "assistant",
  "cli",
  "ui",
  "system",
  "test"
]);
// ../lib/src/control-plane/markdown-task.ts
var logger6 = createLogger("markdown-task");

// ../lib/src/control-plane/scheduler.ts
var logger7 = createLogger("scheduler");
// ../lib/src/control-plane/model-runner.ts
var logger8 = createLogger("local-providers");
// ../lib/src/control-plane/setup.ts
var logger9 = createLogger("setup");
// ../lib/src/control-plane/host-opencode.ts
var ALLOWED_CONFIG_KEYS = new Set(["$schema", "provider", "model", "small_model", "disabled_providers"]);
// ../lib/src/control-plane/ui-assets.ts
var import_tar = __toESM(require_tar(), 1);
import {
  existsSync,
  mkdirSync as mkdirSync2,
  readdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  renameSync
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
var logger10 = createLogger("lib:ui-assets");
var REPO_OWNER = "itlackey";
var REPO_NAME = "openpalm";
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0;i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok || res.status < 500)
        return res;
      if (i < retries - 1)
        await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    } catch (err) {
      if (i === retries - 1)
        throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}
function copyTree(src, dest, opts) {
  if (!existsSync(src))
    return;
  const entries = readdirSync(src, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const parentDir = entry.parentPath ?? entry.path;
    const srcFile = join(parentDir, entry.name);
    const rel = relative(src, srcFile);
    const destFile = join(dest, rel);
    if (opts?.skipExisting && existsSync(destFile))
      continue;
    mkdirSync2(dirname(destFile), { recursive: true });
    copyFileSync(srcFile, destFile);
  }
}
function resolveLocalCandidate(...strategies) {
  for (const strategy of strategies) {
    try {
      const p = strategy();
      if (p && existsSync(p))
        return p;
    } catch {}
  }
  return null;
}
function resolveLocalUiBuild() {
  return resolveLocalCandidate(() => process.env.OPENPALM_REPO_ROOT ? join(process.env.OPENPALM_REPO_ROOT, "packages", "ui", "build") : null, () => {
    const meta = fileURLToPath(import.meta.url);
    if (meta.startsWith("/$bunfs/"))
      return null;
    const candidate = join(dirname(meta), "..", "..", "..", "..", "packages", "ui", "build");
    return existsSync(join(candidate, "index.js")) ? candidate : null;
  }, () => {
    const binDir = dirname(realpathSync(process.execPath));
    const candidate = join(binDir, "..", "..", "..", "packages", "ui", "build");
    return existsSync(join(candidate, "index.js")) ? candidate : null;
  });
}
function resolveUiBuildDir() {
  const stateBuild = join(resolveStateDir(), "ui");
  if (existsSync(join(stateBuild, "index.js")))
    return stateBuild;
  return resolveLocalUiBuild() ?? stateBuild;
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function parseChecksumsFile(content) {
  const map = new Map;
  for (const line of content.trim().split(`
`)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      map.set(parts[parts.length - 1], parts[0]);
    }
  }
  return map;
}
async function seedUiBuild(repoRef, stateDir) {
  const uiDir = join(stateDir, "ui");
  mkdirSync2(uiDir, { recursive: true });
  const local = resolveLocalUiBuild();
  if (local) {
    logger10.debug("seeding UI build from local source", { src: local });
    copyTree(local, uiDir);
    return;
  }
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}`;
  const tarballUrl = `${base}/ui-build.tar.gz`;
  const checksumUrl = `${base}/checksums-sha256.txt`;
  logger10.debug("downloading UI build", { url: tarballUrl });
  const tmpTar = join(stateDir, ".ui-build.tar.gz.tmp");
  try {
    const [tarRes, csRes] = await Promise.all([
      fetchWithRetry(tarballUrl),
      fetchWithRetry(checksumUrl).catch(() => null)
    ]);
    if (!tarRes.ok)
      throw new Error(`Failed to download UI build (HTTP ${tarRes.status})`);
    const tarData = new Uint8Array(await tarRes.arrayBuffer());
    if (csRes?.ok) {
      const checksums = parseChecksumsFile(await csRes.text());
      const expected = checksums.get("ui-build.tar.gz");
      if (expected) {
        const actual = sha256Hex(tarData);
        if (actual !== expected) {
          throw new Error(`UI build checksum mismatch (expected ${expected}, got ${actual})`);
        }
        logger10.debug("UI build checksum verified", { sha256: actual });
      }
    }
    writeFileSync(tmpTar, tarData);
    await import_tar.default.x({ file: tmpTar, cwd: uiDir, strip: 1 });
  } finally {
    rmSync(tmpTar, { force: true });
  }
}
var GITHUB_API = "https://api.github.com";
function compareVersionTags(a, b) {
  const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM)
    return aM > bM ? 1 : -1;
  if (am !== bm)
    return am > bm ? 1 : -1;
  if (ap !== bp)
    return ap > bp ? 1 : -1;
  return 0;
}
async function checkAndUpdateUiBuild(currentVersion, stateDir) {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
      headers: { "User-Agent": `OpenPalm/${currentVersion}` },
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) {
      return { updated: false, latestVersion: null, error: `GitHub API returned ${res.status}` };
    }
    const release = await res.json();
    const latestTag = release.tag_name;
    const latestVersion = latestTag.replace(/^v/, "");
    if (compareVersionTags(latestTag, currentVersion) <= 0) {
      logger10.debug("UI build is up to date", { current: currentVersion, latest: latestVersion });
      return { updated: false, latestVersion };
    }
    if (!release.assets.some((a) => a.name === "ui-build.tar.gz")) {
      return { updated: false, latestVersion, error: "Latest release has no ui-build.tar.gz" };
    }
    const uiDir = join(stateDir, "ui");
    if (existsSync(join(uiDir, "index.js"))) {
      const backupDir = join(stateDir, "backups", `ui-${Date.now()}`);
      mkdirSync2(join(stateDir, "backups"), { recursive: true });
      renameSync(uiDir, backupDir);
      logger10.debug("backed up UI build before update", { backup: backupDir });
    }
    await seedUiBuild(latestTag, stateDir);
    logger10.debug("UI build updated", { from: currentVersion, to: latestVersion });
    return { updated: true, latestVersion };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger10.debug("UI build update check failed (non-fatal)", { error });
    return { updated: false, latestVersion: null, error };
  }
}
// src/main.ts
if (!globalThis.Bun) {
  globalThis.Bun = { env: process.env };
}
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname2 = dirname2(__filename2);
var UI_PORT = Number(process.env.OP_HOST_UI_PORT) || 3880;
var READY_TIMEOUT_MS = 20000;
var mainWindow = null;
var tray = null;
var uiProcess = null;
function buildUIServerEnv(homeDir, port) {
  return {
    ...process.env,
    OP_HOME: homeDir,
    HOST: "127.0.0.1",
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`
  };
}
async function waitForReady(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (res.ok || res.status === 401)
        return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
async function startUIServer() {
  const homeDir = resolveOpenPalmHome();
  const stateDir = resolveStateDir();
  resolveConfigDir();
  ensureHomeDirs();
  const version = app.getVersion();
  const updateResult = await checkAndUpdateUiBuild(version, stateDir);
  if (updateResult.updated) {
    console.log(`UI updated to v${updateResult.latestVersion}`);
  } else if (updateResult.error) {
    console.log(`UI update check skipped: ${updateResult.error}`);
  }
  let uiBuildDir = resolveUiBuildDir();
  if (!existsSync2(join2(uiBuildDir, "index.js"))) {
    console.log("UI build not found — seeding from release...");
    try {
      await seedUiBuild(`v${version}`, stateDir);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error("Failed to seed UI build:", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }
  uiProcess = spawn2("node", [join2(uiBuildDir, "index.js")], {
    cwd: uiBuildDir,
    env: buildUIServerEnv(homeDir, UI_PORT),
    stdio: "inherit"
  });
  uiProcess.on("error", (err) => {
    console.error("UI server process error:", err.message);
  });
  uiProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`UI server exited with code ${code}`);
    }
    uiProcess = null;
  });
  const ready = await waitForReady(UI_PORT);
  if (!ready) {
    console.error("UI server did not become ready in time");
    app.quit();
  }
}
function stopUIServer() {
  if (uiProcess) {
    uiProcess.kill("SIGTERM");
    uiProcess = null;
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "OpenPalm",
    webPreferences: {
      preload: join2(__dirname2, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${UI_PORT}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}
function createTray() {
  const iconPath = join2(__dirname2, "..", "assets", "tray-icon.png");
  if (!existsSync2(iconPath)) {
    return;
  }
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Open OpenPalm", click: showWindow },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip("OpenPalm");
  tray.setContextMenu(contextMenu);
  tray.on("click", showWindow);
}
app.whenReady().then(async () => {
  await startUIServer();
  createWindow();
  createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow();
    else
      showWindow();
  });
});
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  app.isQuitting = true;
  stopUIServer();
});
export {
  waitForReady,
  buildUIServerEnv
};
