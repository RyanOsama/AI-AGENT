const crypto = require('crypto');
const db = require('./database');

/**
 * توليد بصمة رقمية مشفرة فريدة لكل وظيفة لمنع التكرار (SHA256 Fingerprint)
 * تعتمد على اسم الشركة المنظف، المسمى الوظيفي، والرابط الأساسي بدون معاملات التتبع
 */
function generateJobFingerprint(company, title, url) {
  const normCompany = String(company || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|co|corp|technologies|solutions)\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .trim();

  const normTitle = String(title || '')
    .toLowerCase()
    .replace(/\b(senior|junior|mid|lead|staff|principal)\b/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .trim();

  // تنظيف الرابط من وسوم التتبع مثل utm_source و ref
  let cleanUrl = '';
  try {
    const parsed = new URL(url);
    cleanUrl = (parsed.origin + parsed.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    cleanUrl = String(url || '').split('?')[0].toLowerCase().replace(/\/+$/, '');
  }

  const rawString = `${normCompany}|${normTitle}|${cleanUrl}`;
  return crypto.createHash('sha256').update(rawString).digest('hex');
}

/**
 * تنظيف نصوص HTML من وصف الوظائف
 */
function stripHtmlTags(htmlStr) {
  if (!htmlStr) return '';
  return htmlStr
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * استخراج وتوحيد قيم الراتب بالدولار الأمريكي شهرياً
 */
function parseSalaryInfo(salaryRaw, defaultMin = null, defaultMax = null) {
  if (defaultMin || defaultMax) {
    let min = defaultMin ? Number(defaultMin) : null;
    let max = defaultMax ? Number(defaultMax) : null;

    // تحويل الراتب السنوي إلى شهري إذا كان سنوياً (أكبر من 15,000$)
    if (min && min > 15000) min = Math.round(min / 12);
    if (max && max > 15000) max = Math.round(max / 12);

    return {
      salary_raw: salaryRaw || (min && max ? `$${min} - $${max}/mo` : min ? `$${min}+/mo` : null),
      salary_min: min,
      salary_max: max
    };
  }

  if (!salaryRaw || typeof salaryRaw !== 'string') {
    return { salary_raw: 'غير معلن (قابل للتفاوض)', salary_min: null, salary_max: null };
  }

  // البحث عن أرقام داخل النص (مثل: $100k - $140k أو 3000 USD أو 60k)
  const numbers = [];
  const kMatches = [...salaryRaw.matchAll(/(\d+(?:\.\d+)?)\s*k\b/gi)];
  if (kMatches.length > 0) {
    kMatches.forEach(m => numbers.push(parseFloat(m[1]) * 1000));
  } else {
    const rawMatches = [...salaryRaw.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,6})/g)];
    rawMatches.forEach(m => numbers.push(parseFloat(m[1].replace(/,/g, ''))));
  }

  if (numbers.length === 0) {
    return { salary_raw: salaryRaw.trim(), salary_min: null, salary_max: null };
  }

  let min = numbers[0];
  let max = numbers[1] || min;

  // إذا كان سنوياً نحوله لشهري
  if (min > 15000) min = Math.round(min / 12);
  if (max > 15000) max = Math.round(max / 12);

  return {
    salary_raw: salaryRaw.trim(),
    salary_min: min,
    salary_max: max
  };
}

/**
 * تحديد نوع العمل (Remote / On-site / Hybrid)
 */
function determineWorkType(location = '', isRemoteFlag = false, title = '', desc = '') {
  const combined = `${location} ${title} ${desc}`.toLowerCase();
  if (combined.includes('hybrid') || combined.includes('هجين')) {
    return 'hybrid';
  }
  if (isRemoteFlag || combined.includes('remote') || combined.includes('anywhere') || combined.includes('worldwide') || combined.includes('عن بعد')) {
    return 'remote';
  }
  return 'on-site';
}

// ---------------- 1. جلب من Remotive API الرسمي ---------------- //
async function fetchRemotiveJobs(category = 'software-dev') {
  try {
    const url = `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}&limit=40`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!res.ok) throw new Error(`Remotive API responded with HTTP ${res.status}`);

    const data = await res.json();
    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000; // 14 يوماً كحد أقصى لمنع الوظائف المؤرشفة
    const now = Date.now();

    const validJobs = [];

    for (const j of rawJobs) {
      const pubTime = j.publication_date ? new Date(j.publication_date).getTime() : now;
      if (now - pubTime > maxAgeMs) {
        // تخطي الوظائف القديمة التي أصبحت مؤرشفة على موقع ريموتف
        continue;
      }

      const salaryParsed = parseSalaryInfo(j.salary);
      const cleanDesc = stripHtmlTags(j.description);
      const workType = determineWorkType(j.candidate_required_location, true, j.title, cleanDesc);
      const publishedDate = new Date(pubTime).toISOString();

      validJobs.push({
        fingerprint: generateJobFingerprint(j.company_name, j.title, j.url),
        source: 'Remotive',
        source_job_id: String(j.id || ''),
        company: j.company_name || 'Unknown',
        title: j.title || 'Untitled',
        location: j.candidate_required_location || 'Worldwide (عن بعد)',
        work_type: workType,
        salary_raw: salaryParsed.salary_raw,
        salary_min: salaryParsed.salary_min,
        salary_max: salaryParsed.salary_max,
        url: j.url,
        apply_url: j.url,
        description: cleanDesc.substring(0, 4500),
        tags: Array.isArray(j.tags) ? j.tags : [],
        published_at: publishedDate,
        expires_at: null,
        employment_type: j.job_type || 'Full-time',
        application_status: 'NEW'
      });
    }

    return validJobs;
  } catch (err) {
    console.warn('[JobSourcing] خطأ جلب Remotive:', err.message);
    return [];
  }
}

// ---------------- 2. جلب من RemoteOK API الرسمي ---------------- //
async function fetchRemoteOkJobs() {
  try {
    const url = 'https://remoteok.com/api';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AIJobSearchAgent/1.0'
      }
    });
    if (!res.ok) throw new Error(`RemoteOK API responded with HTTP ${res.status}`);

    const data = await res.json();
    const rawJobs = Array.isArray(data) ? data.slice(1, 40) : [];
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const validJobs = [];

    for (const j of rawJobs) {
      const pubTime = j.date ? new Date(j.date).getTime() : (j.epoch ? j.epoch * 1000 : now);
      if (now - pubTime > maxAgeMs) continue;

      const salaryParsed = parseSalaryInfo(null, j.salary_min, j.salary_max);
      const cleanDesc = stripHtmlTags(j.description);
      const workType = determineWorkType(j.location, true, j.position, cleanDesc);
      const jobUrl = j.url || `https://remoteok.com/remote-jobs/${j.id}`;
      const publishedDate = new Date(pubTime).toISOString();

      validJobs.push({
        fingerprint: generateJobFingerprint(j.company, j.position, jobUrl),
        source: 'RemoteOK',
        source_job_id: String(j.id || ''),
        company: j.company || 'Unknown',
        title: j.position || 'Untitled',
        location: j.location || 'Worldwide (عن بعد)',
        work_type: workType,
        salary_raw: salaryParsed.salary_raw,
        salary_min: salaryParsed.salary_min,
        salary_max: salaryParsed.salary_max,
        url: jobUrl,
        apply_url: j.apply_url || jobUrl,
        description: cleanDesc.substring(0, 4500),
        tags: Array.isArray(j.tags) ? j.tags : [],
        published_at: publishedDate,
        expires_at: null,
        employment_type: 'Full-time',
        application_status: 'NEW'
      });
    }

    return validJobs;
  } catch (err) {
    console.warn('[JobSourcing] خطأ جلب RemoteOK:', err.message);
    return [];
  }
}

// ---------------- 3. جلب من Arbeitnow API الرسمي ---------------- //
async function fetchArbeitnowJobs() {
  try {
    const url = 'https://www.arbeitnow.com/api/job-board-api';
    const res = await fetch(url, { headers: { 'User-Agent': 'JobSearchAgent/1.0' } });
    if (!res.ok) throw new Error(`Arbeitnow API responded with HTTP ${res.status}`);

    const data = await res.json();
    const rawJobs = Array.isArray(data.data) ? data.data.slice(0, 35) : [];
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const validJobs = [];

    for (const j of rawJobs) {
      const pubTime = j.created_at ? j.created_at * 1000 : now;
      if (now - pubTime > maxAgeMs) continue;

      const cleanDesc = stripHtmlTags(j.description);
      const workType = determineWorkType(j.location, j.remote, j.title, cleanDesc);
      const publishedDate = new Date(pubTime).toISOString();

      validJobs.push({
        fingerprint: generateJobFingerprint(j.company_name, j.title, j.url),
        source: 'Arbeitnow',
        source_job_id: String(j.slug || ''),
        company: j.company_name || 'Unknown',
        title: j.title || 'Untitled',
        location: j.location || (j.remote ? 'Remote' : 'On-site'),
        work_type: workType,
        salary_raw: 'غير معلن (يحدد في المقابلة)',
        salary_min: null,
        salary_max: null,
        url: j.url,
        apply_url: j.url,
        description: cleanDesc.substring(0, 4500),
        tags: Array.isArray(j.tags) ? j.tags : (Array.isArray(j.job_types) ? j.job_types : []),
        published_at: publishedDate,
        expires_at: null,
        employment_type: Array.isArray(j.job_types) && j.job_types.length > 0 ? j.job_types.join(', ') : 'Full-time',
        application_status: 'NEW'
      });
    }

    return validJobs;
  } catch (err) {
    console.warn('[JobSourcing] خطأ جلب Arbeitnow:', err.message);
    return [];
  }
}

// ---------------- 4. جلب وظائف LinkedIn السعودية والخليج ---------------- //
async function fetchLinkedInJobs() {
  try {
    const searchTargets = [
      { kw: 'Backend Developer', loc: 'Saudi Arabia' },
      { kw: 'Full Stack Developer Laravel', loc: 'Saudi Arabia' },
      { kw: 'Node.js Developer', loc: 'Saudi Arabia' },
      { kw: 'Software Engineer', loc: 'United Arab Emirates' }
    ];

    const allLinkedInJobs = [];

    for (const target of searchTargets) {
      try {
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(target.kw)}&location=${encodeURIComponent(target.loc)}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept-Language': 'ar,en;q=0.9'
          }
        });
        if (!res.ok) continue;

        const html = await res.text();
        const items = html.split('<li');

        for (const item of items) {
          const titleMatch = item.match(/class=["']base-search-card__title["'][^>]*>([\s\S]*?)<\/h3>/i);
          const compMatch = item.match(/class=["']base-search-card__subtitle["'][^>]*>([\s\S]*?)<\/h4>/i);
          const locMatch = item.match(/class=["']job-search-card__location["'][^>]*>([\s\S]*?)<\/span>/i);
          const linkMatch = item.match(/class=["']base-card__full-link[^"']*["'][^>]*href=["']([^"']+)["']/i);
          const idMatch = item.match(/data-entity-urn=["']urn:li:jobPosting:(\d+)["']/i);

          if (titleMatch && linkMatch) {
            const cleanTitle = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            const cleanComp = compMatch ? compMatch[1].replace(/<[^>]+>/g, '').trim() : 'LinkedIn Employer';
            const cleanLoc = locMatch ? locMatch[1].replace(/<[^>]+>/g, '').trim() : target.loc;
            const cleanUrl = linkMatch[1].split('?')[0];
            const workType = determineWorkType(cleanLoc, false, cleanTitle, '');

            allLinkedInJobs.push({
              fingerprint: generateJobFingerprint(cleanComp, cleanTitle, cleanUrl),
              source: 'LinkedIn (Saudi/Gulf)',
              source_job_id: idMatch ? idMatch[1] : String(Date.now()),
              company: cleanComp,
              title: cleanTitle,
              location: `${cleanLoc} 🇸🇦`,
              work_type: workType,
              salary_raw: 'غير معلن (حسب الخبرة وسلّم الرواتب)',
              salary_min: null,
              salary_max: null,
              url: cleanUrl,
              apply_url: cleanUrl,
              description: `وظيفة مطور برمجيات معلنة على منصة LinkedIn في ${cleanComp} (${cleanLoc}). المسمى: ${cleanTitle}`,
              tags: ['LinkedIn', 'Saudi/Gulf', 'Backend', 'Full Stack'],
              published_at: new Date().toISOString(),
              expires_at: null,
              employment_type: 'Full-time',
              application_status: 'NEW'
            });
          }
        }
      } catch (err) {
        console.warn(`[JobSourcing] خطأ في استعلام LinkedIn (${target.kw}):`, err.message);
      }
    }

    return allLinkedInJobs;
  } catch (err) {
    console.warn('[JobSourcing] خطأ جلب LinkedIn:', err.message);
    return [];
  }
}

// ---------------- Mostaql removed per user request ---------------- //

// ---------------- 6. جلب وظائف الخليج والشرق الأوسط (Remotive Gulf & MENA Hub) ---------------- //
async function fetchGulfAndMiddleEastJobs() {
  try {
    const gulfJobs = [];
    const remotiveDevUrl = 'https://remotive.com/api/remote-jobs?search=developer&limit=30';
    const res = await fetch(remotiveDevUrl, { headers: { 'User-Agent': 'JobSearchAgent/1.0' } });
    if (res.ok) {
      const data = await res.json();
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      
      for (const j of rawJobs) {
        const desc = (j.description || '').toLowerCase();
        const loc = (j.candidate_required_location || '').toLowerCase();
        
        let regionalLocation = j.candidate_required_location || 'Remote (الشرق الأوسط / عالمي)';
        let isGulfTargeted = false;

        if (loc.includes('saudi') || loc.includes('riyadh') || loc.includes('ksa') || desc.includes('saudi') || desc.includes('riyadh')) {
          regionalLocation = 'السعودية 🇸🇦 (الرياض / عن بعد)';
          isGulfTargeted = true;
        } else if (loc.includes('uae') || loc.includes('dubai') || loc.includes('emirates') || desc.includes('dubai')) {
          regionalLocation = 'الإمارات 🇦🇪 (دبي / عن بعد)';
          isGulfTargeted = true;
        } else if (loc.includes('qatar') || loc.includes('doha') || desc.includes('qatar') || desc.includes('doha')) {
          regionalLocation = 'قطر 🇶🇦 (الدوحة / عن بعد)';
          isGulfTargeted = true;
        } else if (loc.includes('worldwide') || loc.includes('anywhere') || loc.includes('mena') || loc.includes('middle east')) {
          regionalLocation = 'عن بعد (متاح للشرق الأوسط والخليج) 🌐';
          isGulfTargeted = true;
        }

        if (isGulfTargeted) {
          const salaryParsed = parseSalaryInfo(j.salary);
          const cleanDesc = stripHtmlTags(j.description);
          const workType = determineWorkType(regionalLocation, true, j.title, cleanDesc);
          const publishedDate = j.publication_date ? new Date(j.publication_date).toISOString() : new Date().toISOString();

          gulfJobs.push({
            fingerprint: generateJobFingerprint(j.company_name, j.title, j.url),
            source: 'Gulf & MENA Hub',
            source_job_id: String(j.id || ''),
            company: j.company_name || 'Tech Company',
            title: j.title || 'Software Engineer',
            location: regionalLocation,
            work_type: workType,
            salary_raw: salaryParsed.salary_raw,
            salary_min: salaryParsed.salary_min,
            salary_max: salaryParsed.salary_max,
            url: j.url,
            apply_url: j.url,
            description: cleanDesc.substring(0, 4500),
            tags: Array.isArray(j.tags) ? j.tags : ['Backend', 'Full Stack', 'Gulf/MENA'],
            published_at: publishedDate,
            expires_at: null,
            employment_type: j.job_type || 'Full-time',
            application_status: 'NEW'
          });
        }
      }
    }

    return gulfJobs;
  } catch (err) {
    console.warn('[JobSourcing] خطأ جلب وظائف الخليج:', err.message);
    return [];
  }
}

// ---------------- 7. جلب من مصادر API مخصصة مضافة من قبل المستخدم ---------------- //
async function fetchGenericApiJobs(sourceObj) {
  try {
    const endpoint = sourceObj.api_endpoint || sourceObj.url;
    if (!endpoint) return [];

    const res = await fetch(endpoint, {
      headers: { 'User-Agent': 'JobSearchAgent/1.0' }
    });
    if (!res.ok) throw new Error(`Custom Source HTTP ${res.status}`);

    const data = await res.json();
    const rawList = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data.data) ? data.data : []));

    return rawList.slice(0, 25).map(j => {
      const title = j.title || j.position || j.role || 'Software Engineer';
      const company = j.company || j.company_name || sourceObj.name;
      const url = j.url || j.apply_url || sourceObj.url;
      const desc = stripHtmlTags(j.description || j.details || '');
      const workType = determineWorkType(j.location, !!j.remote, title, desc);

      return {
        fingerprint: generateJobFingerprint(company, title, url),
        source: sourceObj.name,
        source_job_id: String(j.id || ''),
        company: company,
        title: title,
        location: j.location || 'Remote',
        work_type: workType,
        salary_raw: j.salary || 'غير معلن',
        salary_min: j.salary_min || null,
        salary_max: j.salary_max || null,
        url: url,
        apply_url: j.apply_url || url,
        description: desc.substring(0, 4500),
        tags: Array.isArray(j.tags) ? j.tags : [sourceObj.name],
        published_at: j.published_at || j.created_at || new Date().toISOString(),
        expires_at: j.expires_at || j.deadline || null,
        employment_type: j.job_type || 'Full-time',
        application_status: 'NEW'
      };
    });
  } catch (err) {
    console.warn(`[JobSourcing] خطأ جلب المصدر المخصص (${sourceObj.name}):`, err.message);
    return [];
  }
}

// ---------------- المنسق الرئيسي لجلب وفهرسة الوظائف ---------------- //
/**
 * وكيل استكشاف وجلب الوظائف (JobSourcingAgent)
 * يجلب الوظائف حصراً من المصادر المفعلة في جدول job_sources
 */
async function runJobSourcingCycle() {
  console.log(`[JobSourcingAgent] التحقق من المصادر المفعلة في النظام...`);

  // جلب المصادر المفعلة فقط
  const activeSources = await db.getActiveSources();
  if (!activeSources || activeSources.length === 0) {
    const msg = 'لا توجد مصادر وظائف مفعلة حالياً. يرجى تفعيل مصدر واحد على الأقل في صفحة مصادر الوظائف.';
    console.warn(`[JobSourcingAgent] ${msg}`);
    return {
      success: false,
      message: msg,
      totalReceived: 0,
      newlyInserted: 0,
      duplicatesSkipped: 0,
      sourcesChecked: []
    };
  }

  const tasks = [];
  const sourceNameMap = new Map();

  for (const src of activeSources) {
    const srcName = src.name.toLowerCase();
    let fetchPromise = null;

    if (srcName.includes('remotive') && !srcName.includes('gulf') && !srcName.includes('mena')) {
      fetchPromise = fetchRemotiveJobs('software-dev');
    } else if (srcName.includes('remoteok')) {
      fetchPromise = fetchRemoteOkJobs();
    } else if (srcName.includes('arbeitnow')) {
      fetchPromise = fetchArbeitnowJobs();
    } else if (srcName.includes('linkedin')) {
      fetchPromise = fetchLinkedInJobs();
    } else if (srcName.includes('gulf') || srcName.includes('mena') || srcName.includes('الخليج')) {
      fetchPromise = fetchGulfAndMiddleEastJobs();
    } else if (src.type === 'api' && src.api_endpoint) {
      fetchPromise = fetchGenericApiJobs(src);
    }

    if (fetchPromise) {
      tasks.push(
        fetchPromise.then(jobs => ({ source: src, jobs }))
      );
    }
  }

  const results = await Promise.allSettled(tasks);
  const allCollectedJobs = [];
  const sourceStatsSummary = [];

  for (const res of results) {
    if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.jobs)) {
      const { source, jobs } = res.value;
      allCollectedJobs.push(...jobs);

      // حفظ دفعة هذا المصدر وتحديث إحصائياته بدقة
      let srcNew = 0;
      let srcDup = 0;
      for (const job of jobs) {
        if (!job.fingerprint) continue;
        const exists = await db.isJobDuplicate(job.fingerprint);
        if (exists) {
          srcDup++;
        } else {
          const saveRes = await db.saveJobListing(job);
          if (saveRes.inserted) srcNew++;
          else srcDup++;
        }
      }

      await db.updateJobSourceStats(source.name, {
        fetchedCount: jobs.length,
        validCount: srcNew,
        duplicatesCount: srcDup
      });

      sourceStatsSummary.push({
        sourceName: source.name,
        fetched: jobs.length,
        new: srcNew,
        duplicates: srcDup
      });
    }
  }

  const totalReceived = sourceStatsSummary.reduce((sum, s) => sum + s.fetched, 0);
  const newlyInserted = sourceStatsSummary.reduce((sum, s) => sum + s.new, 0);
  const duplicatesSkipped = sourceStatsSummary.reduce((sum, s) => sum + s.duplicates, 0);

  const logMessage = `اكتمل جلب الوظائف من ${activeSources.length} مصادر مفعلة: تم استلام ${totalReceived} وظيفة، وحفظ ${newlyInserted} وظيفة جديدة، وتخطي ${duplicatesSkipped} مكررة.`;
  console.log(`[JobSourcingAgent] ${logMessage}`);
  await db.logEvent('INFO', 'دورة استكشاف الوظائف', logMessage);

  return {
    success: true,
    totalReceived,
    newlyInserted,
    duplicatesSkipped,
    sourcesChecked: activeSources.map(s => s.name),
    sourceStatsSummary
  };
}

module.exports = {
  generateJobFingerprint,
  stripHtmlTags,
  parseSalaryInfo,
  determineWorkType,
  fetchLinkedInJobs,
  fetchGulfAndMiddleEastJobs,
  fetchRemotiveJobs,
  fetchRemoteOkJobs,
  fetchArbeitnowJobs,
  runJobSourcingCycle
};
