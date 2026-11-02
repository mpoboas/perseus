/** Which files the diff view shows as pictures instead of text. */

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const extension = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The picture type of a file name, or null when it is not one the webview can draw. */
export const imageType = (path: string): string | null => TYPES[extension(path)] ?? null;

/** SVG is text as well as a picture, so its diff can be read either way. */
export const isSvg = (path: string) => extension(path) === "svg";
