`decoders.js` bundles two pure-JavaScript decoders that iRelay uses to unpack Steam chunks:

- [lzma1](https://www.npmjs.com/package/lzma1) 0.6.5 (MIT), the LZMA decoder.
- [fzstd](https://www.npmjs.com/package/fzstd) 0.1.1 (MIT), the zstd decoder.

The file is built with `esbuild --bundle --format=cjs --minify` and is kept inside `app/`, so update archives include it.
