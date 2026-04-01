import * as fs from 'fs';

const text1 = 'إيداع بمبلغ 500 جنيه في حساب محمد علي مرجع DEP123';
const text2 = 'إنستاباي تحويل 750 جنيه من سارة أحمد مرجع IP456';
const text3 = 'تحويل بمبلغ 3000 جنيه من خالد محمد مرجع TRF789';

const r1 = /إيداع بمبلغ ([\d,.]+) (جنيه|مصري|دولار) (?:في|إلى) حساب (.*?)(?:\s*مرجع ([\w-]+))?/i;
const r2 = /إنستاباي.*?([\d,.]+) (جنيه|مصري|EGP|دولار|USD).*?من (.*?)(?:\s*مرجع ([\w-]+))?/i;
const r3 = /(تحويل|حوالة) بمبلغ ([\d,.]+) (جنيه|مصري|دولار) من (.*?) مرجع ([\w-]+)/i;

console.log('deposit_ar match:', r1.test(text1), text1.match(r1));
console.log('instapay_ar match:', r2.test(text2), text2.match(r2));
console.log('transfer_ar match:', r3.test(text3), text3.match(r3));
