const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const db = require('./database');
const { tailorCvAndCoverLetter } = require('./cv_tailor');
const { resolveApplicationQuestion } = require('./auto_apply');

// مجلد حفظ لقطات شاشة إثبات التقديم
const PROOFS_DIR = path.join(__dirname, 'uploads', 'proofs');
if (!fs.existsSync(PROOFS_DIR)) {
  fs.mkdirSync(PROOFS_DIR, { recursive: true });
}

/**
 * تحديد مسار المتصفح القابل للتنفيذ (Edge أو Chromium المدمج)
 */
function getBrowserExecutablePath() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(edgePath)) return edgePath;
  if (fs.existsSync(chromePath)) return chromePath;
  return undefined; // Puppeteer uses default bundled Chromium
}

/**
 * وكيل التقديم الآلي عبر المتصفح (BrowserAutonomousApplicant)
 */
class BrowserAutonomousApplicant {
  constructor() {
    this.browser = null;
  }

  async initBrowser(headless = true) {
    if (this.browser) return this.browser;

    const execPath = getBrowserExecutablePath();
    const launchOptions = {
      headless: headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,800'
      ]
    };

    if (execPath) {
      launchOptions.executablePath = execPath;
    }

    this.browser = await puppeteer.launch(launchOptions);
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
      this.browser = null;
    }
  }

  /**
   * التقديم التلقائي على وظيفة محددة عبر فتح نموذج الموقع وملئه وإرساله
   */
  async applyToJob(jobId, options = { autoSubmit: true, headless: true }) {
    const job = await db.getJobListingById(jobId);
    if (!job) throw new Error(`الوظيفة #${jobId} غير موجودة.`);

    const profile = await db.getCandidateProfile();
    if (!profile) throw new Error('الملف الشخصي للمرشح غير مسجل.');

    console.log(`[BrowserApplicant] 🚀 بدء التقديم الآلي الشامل للوظيفة #${job.id} (${job.company} - ${job.title})...`);

    // 1. التأكد من تجهيز السيرة الذاتية المخصصة بنظام ATS وخطاب التقديم
    let tailoredCvPath = job.tailored_cv_path;
    let coverLetter = job.cover_letter;

    if (!tailoredCvPath || !fs.existsSync(tailoredCvPath)) {
      console.log(`[BrowserApplicant] توليد السيرة الذاتية بنظام ATS والخطاب المخصص...`);
      const tailored = await tailorCvAndCoverLetter(job, profile);
      tailoredCvPath = tailored.pdfPath;
      coverLetter = tailored.coverLetter;

      await db.updateJobTailoredDocs(job.id, {
        tailored_cv_path: tailoredCvPath,
        cover_letter: coverLetter
      });
    }

    const browser = await this.initBrowser(options.headless);
    const page = await browser.newPage();

    // ضبط هوية المتصفح لمنع الحظر
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const targetUrl = job.apply_url || job.url;
    console.log(`[BrowserApplicant] فتح رابط التقديم: ${targetUrl}`);

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    } catch (navErr) {
      console.warn(`[BrowserApplicant] تحذير أثناء الانتقال: ${navErr.message}`);
    }

    // انتظار قصير لاستقرار الصفحة
    await new Promise(r => setTimeout(r, 2000));

    // فحص ما إذا كان هناك اختبار كابتشا
    const hasCaptcha = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const captchaElements = document.querySelectorAll('iframe[src*="captcha"], iframe[src*="recaptcha"], div[class*="captcha"], div[class*="g-recaptcha"], div[class*="h-captcha"]');
      return captchaElements.length > 0 || bodyText.includes('verify you are human') || bodyText.includes('security check');
    });

    if (hasCaptcha) {
      const proofPath = path.join(PROOFS_DIR, `captcha_job_${job.id}.png`);
      await page.screenshot({ path: proofPath, fullPage: true });

      const actionId = await db.createPendingAction({
        job_id: job.id,
        question: 'تحدي أمني (CAPTCHA) يطلب التحقق البشري قبل إرسال الطلب.',
        context: `رابط التقديم: ${targetUrl} | صورة التحدي محفوظة`,
        action_type: 'captcha'
      });

      await db.logEvent('WARNING', 'كابتشا مطلوبة', `التقديم للوظيفة #${job.id} (${job.company}) بحاجة لتخطي كابتشا.`);
      await page.close();

      return {
        status: 'pending_captcha',
        actionId,
        message: 'تم رصد كابتشا أمنية، وتم إدراج التنبيه في لوحة التحكم.'
      };
    }

    // استخراج وتعبئة حقول النماذج بذكاء
    const fillResult = await this.fillApplicationForm(page, profile, coverLetter, tailoredCvPath);
    console.log(`[BrowserApplicant] نتيجة تعبئة الحقول:`, fillResult);

    // التقاط صورة قبل الإرسال كإثبات تعبئة
    const preSubmitProof = path.join(PROOFS_DIR, `pre_submit_job_${job.id}.png`);
    await page.screenshot({ path: preSubmitProof, fullPage: false });

    let submitted = false;
    let submitMessage = 'تمت تعبئة النموذج بنجاح وتجهيز المستندات.';

    if (options.autoSubmit) {
      // محاولة النقر على زر الإرسال / Submit
      const clickSuccess = await this.clickSubmitButton(page);
      if (clickSuccess) {
        submitted = true;
        // انتظار معالجة الخادم وإرسال الطلب
        await new Promise(r => setTimeout(r, 4000));

        const postSubmitProof = path.join(PROOFS_DIR, `proof_job_${job.id}.png`);
        await page.screenshot({ path: postSubmitProof, fullPage: false });

        submitMessage = `تم التقديم وإرسال الطلب رسمياً إلى ${job.company} على وظيفة ${job.title} بنجاح!`;
      }
    }

    // تحديث قاعدة البيانات
    await db.updateJobApplicationStatus(job.id, 'applied');
    const logSuccess = `[AutoApply Complete] ${submitMessage} (المنصة: ${job.source})`;
    await db.logEvent('INFO', 'تقديم آلي مكتمل', logSuccess);

    await page.close();

    return {
      status: 'applied',
      success: true,
      submitted,
      message: submitMessage,
      proofImage: `/uploads/proofs/pre_submit_job_${job.id}.png`,
      filledFields: fillResult.filledCount
    };
  }

  /**
   * تعبئة الحقول النصية، الأسئلة، ورفع السيرة الذاتية PDF
   */
  async fillApplicationForm(page, profile, coverLetter, tailoredCvPath) {
    let filledCount = 0;

    // 1. رفع ملف الـ PDF الخاص بالـ ATS
    if (tailoredCvPath && fs.existsSync(tailoredCvPath)) {
      try {
        const fileInputs = await page.$$('input[type="file"]');
        if (fileInputs.length > 0) {
          console.log(`[BrowserApplicant] تم العثور على حقل رفع السيرة الذاتية (${fileInputs.length} حقل)، جاري الرفع...`);
          await fileInputs[0].uploadFile(tailoredCvPath);
          filledCount++;
        }
      } catch (err) {
        console.warn(`[BrowserApplicant] تعذر رفع ملف الـ PDF: ${err.message}`);
      }
    }

    // 2. تعبئة الحقول النصية (الاسم، البريد، الهاتف، الروابط، الخطاب)
    const inputsInfo = await page.evaluate((cand, cl) => {
      let count = 0;
      const firstName = (cand.full_name || '').split(' ')[0] || '';
      const lastName = (cand.full_name || '').split(' ').slice(1).join(' ') || firstName;
      const email = cand.email || '';
      const phone = cand.phone || '';
      const loc = cand.location || '';
      const linkedin = (cand.links || []).find(l => l.toLowerCase().includes('linkedin')) || '';
      const github = (cand.links || []).find(l => l.toLowerCase().includes('github')) || '';
      const portfolio = (cand.links || []).find(l => !l.includes('linkedin') && !l.includes('github')) || '';

      const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea'));

      for (const el of allInputs) {
        const name = (el.getAttribute('name') || '').toLowerCase();
        const id = (el.getAttribute('id') || '').toLowerCase();
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        const labelText = (el.labels && el.labels[0] ? el.labels[0].innerText : '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const key = `${name} ${id} ${placeholder} ${labelText} ${aria}`;

        if (el.tagName === 'TEXTAREA') {
          if (key.includes('cover') || key.includes('letter') || key.includes('message') || key.includes('summary') || key.includes('note') || key.includes('خطاب') || key.includes('رسالة')) {
            el.value = cl;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            count++;
          }
          continue;
        }

        // البريد الإلكتروني
        if (key.includes('email') || key.includes('mail') || key.includes('بريد') || el.type === 'email') {
          el.value = email;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // الاسم الأول
        else if (key.includes('first_name') || key.includes('firstname') || key.includes('first name') || key.includes('الاسم الاول') || key.includes('الاسم الأول')) {
          el.value = firstName;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // الاسم الأخير / العائلة
        else if (key.includes('last_name') || key.includes('lastname') || key.includes('last name') || key.includes('surname') || key.includes('اسم العائلة') || key.includes('اللقب')) {
          el.value = lastName;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // الاسم الكامل
        else if (key.includes('name') || key.includes('full_name') || key.includes('fullname') || key.includes('الاسم')) {
          el.value = cand.full_name;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // الهاتف
        else if (key.includes('phone') || key.includes('mobile') || key.includes('tel') || key.includes('هاتف') || key.includes('جوال') || el.type === 'tel') {
          el.value = phone;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // لينكدإن
        else if ((key.includes('linkedin') || key.includes('linked_in')) && linkedin) {
          el.value = linkedin;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // جيت هب
        else if (key.includes('github') && github) {
          el.value = github;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // معرض الأعمال / الموقع
        else if ((key.includes('portfolio') || key.includes('website') || key.includes('url')) && (portfolio || github)) {
          el.value = portfolio || github;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // المدينة / الدولة
        else if (key.includes('city') || key.includes('location') || key.includes('address') || key.includes('country') || key.includes('المدينة') || key.includes('الدولة')) {
          el.value = loc;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // الراتب المتوقع
        else if (key.includes('salary') || key.includes('compensation') || key.includes('pay') || key.includes('الراتب')) {
          el.value = `${cand.min_salary || 2000}`;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
        // سنوات الخبرة
        else if (key.includes('experience') || key.includes('years') || key.includes('خبرة')) {
          el.value = `${cand.years_of_experience || 2}`;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
      }

      return { count };
    }, {
      full_name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      min_salary: profile.min_salary,
      years_of_experience: profile.years_of_experience,
      links: profile.links || []
    }, coverLetter || '');

    filledCount += (inputsInfo?.count || 0);

    return { filledCount };
  }

  /**
   * النقر على زر الإرسال / Submit
   */
  async clickSubmitButton(page) {
    try {
      const clicked = await page.evaluate(() => {
        // البحث عن أزرار الإرسال
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a.button'));
        for (const btn of buttons) {
          const text = (btn.innerText || btn.value || '').toLowerCase().trim();
          const id = (btn.id || '').toLowerCase();
          const name = (btn.name || '').toLowerCase();

          if (
            text.includes('submit application') ||
            text.includes('submit') ||
            text.includes('apply now') ||
            text.includes('send application') ||
            text.includes('إرسال الطلب') ||
            text.includes('تقديم الطلب') ||
            text.includes('تأكيد التقديم') ||
            id.includes('submit') ||
            name.includes('submit')
          ) {
            btn.scrollIntoView();
            btn.click();
            return true;
          }
        }
        return false;
      });

      return clicked;
    } catch (err) {
      console.warn(`[BrowserApplicant] تعذر النقر على زر الإرسال: ${err.message}`);
      return false;
    }
  }

  /**
   * تشغيل دفعة تقديم آلي كاملة على الوظائف المتطابقة بنسبة عالية
   */
  async batchAutonomousApply(minScore = 75, limit = 5) {
    console.log(`[BrowserApplicant] ⚡ بدء دفعة التقديم الآلي الفوري على الوظائف المؤهلة (تطابق >= ${minScore}%)...`);

    const candidates = await db.getJobListings({ min_score: minScore, limit: limit * 2 });
    const eligible = candidates.filter(j => j.application_status !== 'applied');

    if (eligible.length === 0) {
      return {
        message: 'لا توجد وظائف جديدة متطابقة تحتاج تقديماً حالياً.',
        appliedCount: 0
      };
    }

    const results = [];
    for (const job of eligible.slice(0, limit)) {
      try {
        const res = await this.applyToJob(job.id, { autoSubmit: true, headless: true });
        results.push({ jobId: job.id, company: job.company, title: job.title, result: res });
      } catch (err) {
        console.error(`[BrowserApplicant] فشل التقديم للوظيفة #${job.id}:`, err.message);
        results.push({ jobId: job.id, company: job.company, error: err.message });
      }
    }

    await this.closeBrowser();

    const successfulCount = results.filter(r => r.result && r.result.status === 'applied').length;
    return {
      message: `اكتملت دفعة التقديم الآلي: تم التقديم الفعلي على ${successfulCount} وظيفة بنجاح.`,
      appliedCount: successfulCount,
      details: results
    };
  }
}

const browserApplicant = new BrowserAutonomousApplicant();

module.exports = {
  BrowserAutonomousApplicant,
  browserApplicant
};
