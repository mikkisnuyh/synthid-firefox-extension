"use strict";

(function () {
  // Copied from synthid.com's <input accept>.
  const ACCEPTED_EXTENSIONS = [
    "jpg", "jpeg", "png", "bmp", "webp", "avif", "heic", "heif", "tiff", "tif", "gif",
    "wav", "mp3", "ogg", "flac", "aac", "m4a",
    "mp4", "mov", "webm",
  ];

  const MIME_TO_EXTENSION = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/apng": "png",
    "image/bmp": "bmp",
    "image/x-bmp": "bmp",
    "image/x-ms-bmp": "bmp",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heic-sequence": "heic",
    "image/heif": "heif",
    "image/heif-sequence": "heif",
    "image/tiff": "tiff",
    "image/gif": "gif",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/vnd.wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "video/ogg": "ogg",
    "application/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/aac": "aac",
    "audio/x-aac": "aac",
    "audio/aacp": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/webm": "webm",
  };

  const MIME_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
  };

  const EXTENSION_TO_MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", bmp: "image/bmp",
    webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
    tiff: "image/tiff", tif: "image/tiff", gif: "image/gif",
    wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac",
    aac: "audio/aac", m4a: "audio/mp4",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  };

  // Extensions that name the same format, so "photo.jpeg" keeps its spelling.
  const SAME_FORMAT = { jpeg: "jpg", tif: "tiff", heif: "heic" };

  // Responses with these types are never media, whatever the URL says (e.g. a login page).
  const NON_MEDIA_MIME = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ecmascript)$)/;

  const DEFAULT_BASE_NAME = "synthid-check";
  const MAX_NAME_LENGTH = 100;
  const MAX_BYTES = 200 * 1024 * 1024;

  function normalizeMime(mime) {
    if (typeof mime !== "string") return "";
    const bare = mime.split(";")[0].trim().toLowerCase();
    return MIME_ALIASES[bare] || bare;
  }

  function extensionForMime(mime) {
    return MIME_TO_EXTENSION[normalizeMime(mime)] || "";
  }

  function mimeForExtension(ext) {
    return EXTENSION_TO_MIME[String(ext || "").toLowerCase()] || "";
  }

  function isAcceptedExtension(ext) {
    return ACCEPTED_EXTENSIONS.includes(String(ext || "").toLowerCase());
  }

  function canonicalExtension(ext) {
    return SAME_FORMAT[ext] || ext;
  }

  function dataUrlMime(url) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma < 0 ? undefined : comma);
    return normalizeMime(meta.split(";")[0]);
  }

  // Last path segment of a URL, decoded, without query or hash.
  function lastPathSegment(url) {
    if (typeof url !== "string" || !url) return "";
    let path;
    try {
      const u = new URL(url);
      if (u.protocol === "blob:" || u.protocol === "data:") return "";
      path = u.pathname;
    } catch {
      path = url.split(/[?#]/)[0];
    }
    const segment = path.split("/").pop() || "";
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  function splitName(segment) {
    const dot = segment.lastIndexOf(".");
    if (dot <= 0) return { base: segment, ext: "" };
    const ext = segment.slice(dot + 1).toLowerCase();
    if (!/^[a-z0-9]{1,8}$/.test(ext)) return { base: segment, ext: "" };
    return { base: segment.slice(0, dot), ext };
  }

  function extensionFromUrl(url) {
    if (typeof url !== "string" || !url) return "";
    if (/^data:/i.test(url)) return extensionForMime(dataUrlMime(url));
    return splitName(lastPathSegment(url)).ext;
  }

  function isAcceptedType(mime, fileName) {
    const type = normalizeMime(mime);
    if (MIME_TO_EXTENSION[type]) return true;
    if (NON_MEDIA_MIME.test(type)) return false;
    const ext = splitName(String(fileName || "").split(/[\\/]/).pop()).ext;
    return isAcceptedExtension(ext);
  }

  function sanitizeBase(base) {
    return base
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[\s._]+|[\s.]+$/g, "");
  }

  function fileNameFor(url, mime) {
    const isInline = typeof url === "string" && /^(data|blob):/i.test(url);
    const parts = isInline ? { base: "", ext: "" } : splitName(lastPathSegment(url));
    const mimeExt = extensionForMime(mime);
    const urlExt = isInline ? "" : parts.ext;

    let ext;
    if (mimeExt) {
      ext = urlExt && canonicalExtension(urlExt) === canonicalExtension(mimeExt) ? urlExt : mimeExt;
    } else {
      ext = urlExt;
    }

    const suffix = ext ? "." + ext : "";
    let base = sanitizeBase(parts.base) || DEFAULT_BASE_NAME;
    base = base.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/[\s.]+$/, "") || DEFAULT_BASE_NAME;
    return base + suffix;
  }

  function percentDecodeToBytes(str) {
    const bytes = [];
    const encoder = new TextEncoder();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(str.substr(i + 1, 2))) {
        bytes.push(parseInt(str.substr(i + 1, 2), 16));
        i += 2;
      } else {
        for (const b of encoder.encode(ch)) bytes.push(b);
      }
    }
    return new Uint8Array(bytes);
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !/^data:/i.test(dataUrl)) {
      throw new Error("Not a data: URL");
    }
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Malformed data: URL");
    const params = dataUrl.slice(5, comma).split(";").map((p) => p.trim());
    const isBase64 = params.length > 1 && params[params.length - 1].toLowerCase() === "base64";
    const type = normalizeMime(params[0]) || "text/plain";
    const payload = dataUrl.slice(comma + 1);

    let bytes;
    if (isBase64) {
      let decoded;
      try {
        decoded = atob(decodeURIComponent(payload).replace(/\s+/g, ""));
      } catch {
        throw new Error("Malformed base64 in data: URL");
      }
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    } else {
      bytes = percentDecodeToBytes(payload);
    }
    return new Blob([bytes], { type });
  }

  function originPattern(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Match patterns can't carry a port; they match all ports.
    return `${u.protocol}//${u.hostname}/*`;
  }

  const api = {
    ACCEPTED_EXTENSIONS,
    MIME_TO_EXTENSION,
    MAX_BYTES,
    normalizeMime,
    extensionForMime,
    mimeForExtension,
    isAcceptedExtension,
    extensionFromUrl,
    isAcceptedType,
    fileNameFor,
    dataUrlToBlob,
    originPattern,
  };

  globalThis.SynthIDMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
