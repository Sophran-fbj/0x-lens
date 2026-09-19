import { launchExtension } from '../browser.mjs';
const ctx = await launchExtension();
const page = ctx.pages()[0] ?? await ctx.newPage();
console.log('UA:', await page.evaluate(() => navigator.userAgent));
console.log('DPR:', await page.evaluate(() => window.devicePixelRatio));
console.log('platform:', await page.evaluate(() => navigator.platform));
await ctx.close();
