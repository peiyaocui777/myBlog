import sharp from "sharp";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
  <rect width="400" height="200" fill="#FAFAF7"/>
  <text x="200" y="100" text-anchor="middle" font-family="Microsoft YaHei" font-size="32" fill="#1A1A1E" font-weight="bold">中文字体测试</text>
  <text x="200" y="150" text-anchor="middle" font-family="Consolas" font-size="20" fill="#B4532A">blog.vorluna.top</text>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("font-test.png");
console.log("done");
