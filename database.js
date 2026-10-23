const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(DB_PATH);

// إعداد الجداول الأساسية
db.serialize(() => {
  // جدول الرسائل المعالجة
  db.run(`
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      thread_id TEXT,
      sender_name TEXT,
      sender_email TEXT,
      company TEXT,
      subject TEXT,
      date TEXT,
      timestamp INTEGER,
      original_language TEXT,
      body_snippet TEXT,
      translated_body TEXT,
      summary TEXT,
      key_points TEXT,
      action_required INTEGER DEFAULT 0,
      action_details TEXT,
      priority TEXT DEFAULT 'عادي',
      gmail_link TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول سجلات النظام والأخطاء
  db.run(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT
    )
  `);

  // جدول الملف الشخصي للمرشح وتفضيلات التوظيف الذكي
  db.run(`
    CREATE TABLE IF NOT EXISTS candidate_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT,
      headline TEXT,
      email TEXT,
      phone TEXT,
      location TEXT,
      links_json TEXT,
      summary TEXT,
      skills_json TEXT,
      all_skills_flat_json TEXT,
      experience_json TEXT,
      education_json TEXT,
      certifications_json TEXT,
      projects_json TEXT,
      languages_json TEXT,
      raw_text TEXT,
      years_of_experience REAL DEFAULT 0,
      min_salary REAL DEFAULT 2000,
      work_types_json TEXT DEFAULT '["remote","on-site","hybrid"]',
      preferred_locations TEXT DEFAULT 'جميع دول العالم للعمل عن بعد / Remote Worldwide',
      target_role TEXT,
      answers_db_json TEXT,
      original_cv_path TEXT,
      original_cv_filename TEXT,
      is_confirmed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول الوظائف المكتشفة والمطابقة مع نظام منع التكرار
  db.run(`
    CREATE TABLE IF NOT EXISTS job_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      source_job_id TEXT,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      work_type TEXT DEFAULT 'remote',
      salary_raw TEXT,
      salary_min REAL,
      salary_max REAL,
      url TEXT NOT NULL,
      apply_url TEXT,
      description TEXT,
      tags_json TEXT,
      match_score INTEGER DEFAULT 0,
      matched_skills_json TEXT,
      missing_skills_json TEXT,
      match_reasons TEXT,
      application_status TEXT DEFAULT 'discovered',
      tailored_cv_path TEXT,
      cover_letter TEXT,
      applied_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول مصادر الوظائف المعتمدة
  db.run(`
    CREATE TABLE IF NOT EXISTS job_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'api',
      api_endpoint TEXT,
      is_active INTEGER DEFAULT 1,
      last_fetch_at DATETIME,
      total_fetched INTEGER DEFAULT 0,
      valid_jobs INTEGER DEFAULT 0,
      duplicates_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول التقديمات اليدوية الموثقة
  db.run(`
    CREATE TABLE IF NOT EXISTS manual_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      job_url TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      tailored_cv_path TEXT,
      cover_letter_used TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // إضافة أعمدة التحليل والترجمة والمهام والتواريخ لجدول الوظائف بأمان
  const extraColumns = [
    { name: 'published_at', type: 'TEXT' },
    { name: 'expires_at', type: 'TEXT' },
    { name: 'employment_type', type: 'TEXT DEFAULT "Full-time"' },
    { name: 'cover_letter_ar', type: 'TEXT' },
    { name: 'cover_letter_en', type: 'TEXT' },
    { name: 'ai_summary_ar', type: 'TEXT' },
    { name: 'title_ar', type: 'TEXT' },
    { name: 'description_ar', type: 'TEXT' },
    { name: 'responsibilities_ar_json', type: 'TEXT' },
    { name: 'responsibilities_en_json', type: 'TEXT' },
    { name: 'req_mandatory_json', type: 'TEXT' },
    { name: 'req_preferred_json', type: 'TEXT' },
    { name: 'req_experience', type: 'TEXT' },
    { name: 'req_education', type: 'TEXT' },
    { name: 'req_languages', type: 'TEXT' },
    { name: 'req_certifications', type: 'TEXT' },
    { name: 'benefits_json', type: 'TEXT' },
    { name: 'match_strengths_json', type: 'TEXT' },
    { name: 'match_weaknesses_json', type: 'TEXT' },
    { name: 'manual_application_notes', type: 'TEXT' }
  ];

  extraColumns.forEach(col => {
    db.run(`ALTER TABLE job_listings ADD COLUMN ${col.name} ${col.type}`, () => {
      // نتجاهل الخطأ إذا كان العمود موجوداً مسبقاً
    });
  });

  // زراعة المصادر الافتراضية المعتمدة
  const defaultSources = [
    ['Remotive', 'https://remotive.com', 'api', 'https://remotive.com/api/remote-jobs?category=software-dev', 1],
    ['RemoteOK', 'https://remoteok.com', 'api', 'https://remoteok.com/api', 1],
    ['Arbeitnow', 'https://www.arbeitnow.com', 'api', 'https://www.arbeitnow.com/api/job-board-api', 1],
    ['Gulf & MENA Hub', 'https://remotive.com', 'api', 'https://remotive.com/api/remote-jobs?search=developer', 1],
    ['LinkedIn (Saudi/Gulf)', 'https://www.linkedin.com', 'scraper', null, 1]
  ];

  defaultSources.forEach(([name, url, type, api_endpoint, is_active]) => {
    db.run(`
      INSERT OR IGNORE INTO job_sources (name, url, type, api_endpoint, is_active)
      VALUES (?, ?, ?, ?, ?)
    `, [name, url, type, api_endpoint, is_active]);
  });
});

// دوال مساعدة مع Promises لسهولة الاستخدام
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// فحص وجود الرسالة لمنع التكرار
async function isMessageProcessed(messageId) {
  const row = await get('SELECT id FROM emails WHERE message_id = ?', [messageId]);
  return !!row;
}

// حفظ رسالة جديدة
async function saveEmail(data) {
  const sql = `
    INSERT OR IGNORE INTO emails (
      message_id, thread_id, sender_name, sender_email, company,
      subject, date, timestamp, original_language, body_snippet,
      translated_body, summary, key_points, action_required,
      action_details, priority, gmail_link
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    data.message_id,
    data.thread_id || '',
    data.sender_name || 'غير معروف',
    data.sender_email || '',
    data.company || 'غير محدد',
    data.subject || '(بدون عنوان)',
    data.date || '',
    data.timestamp || Date.now(),
    data.original_language || 'غير معروف',
    data.body_snippet || '',
    data.translated_body || '',
    data.summary || '',
    JSON.stringify(data.key_points || []),
    data.action_required ? 1 : 0,
    data.action_details || '',
    data.priority || 'عادي',
    data.gmail_link || `https://mail.google.com/mail/u/0/#inbox/${data.message_id}`
  ];
  return run(sql, params);
}

// تسجيل أحداث النظام والأخطاء
async function logEvent(level, message, details = '') {
  const sql = `INSERT INTO system_logs (level, message, details) VALUES (?, ?, ?)`;
  try {
    await run(sql, [level, message, typeof details === 'object' ? JSON.stringify(details) : String(details)]);
  } catch (err) {
    console.error('فشل حفظ السجل:', err);
  }
}

// جلب الإحصائيات
async function getStats() {
  const today = new Date().toISOString().split('T')[0];
  
  const totalRow = await get('SELECT COUNT(*) as total FROM emails');
  const todayRow = await get("SELECT COUNT(*) as today_total FROM emails WHERE date(processed_at) = date('now', 'localtime')");
  const urgentRow = await get("SELECT COUNT(*) as urgent FROM emails WHERE priority = 'عاجل'");
  const importantRow = await get("SELECT COUNT(*) as important FROM emails WHERE priority = 'مهم'");
  const companiesRow = await get("SELECT COUNT(DISTINCT company) as companies_count FROM emails WHERE company != 'غير محدد'");

  return {
    total: totalRow ? totalRow.total : 0,
    today: todayRow ? todayRow.today_total : 0,
    urgent: urgentRow ? urgentRow.urgent : 0,
    important: importantRow ? importantRow.important : 0,
    companies: companiesRow ? companiesRow.companies_count : 0
  };
}

// جلب الرسائل مع فلاتر وبحث
async function getEmails({ limit = 50, offset = 0, priority, company, search, date } = {}) {
  let query = 'SELECT * FROM emails WHERE 1=1';
  const params = [];

  if (priority && priority !== 'all') {
    query += ' AND priority = ?';
    params.push(priority);
  }

  if (company && company !== 'all') {
    query += ' AND company = ?';
    params.push(company);
  }

  if (date) {
    query += " AND date(processed_at) = date(?)";
    params.push(date);
  }

  if (search) {
    query += ' AND (subject LIKE ? OR summary LIKE ? OR sender_name LIKE ? OR company LIKE ? OR translated_body LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }

  query += ' ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await all(query, params);
  return rows.map(r => ({
    ...r,
    key_points: r.key_points ? JSON.parse(r.key_points) : []
  }));
}

// جلب سجل التواريخ المجمعة لصفحة History
async function getHistoryGrouped() {
  const query = `
    SELECT 
      date(processed_at) as day,
      COUNT(*) as total_count,
      COUNT(DISTINCT company) as companies_count,
      SUM(CASE WHEN priority = 'عاجل' THEN 1 ELSE 0 END) as urgent_count,
      SUM(CASE WHEN priority = 'مهم' THEN 1 ELSE 0 END) as important_count
    FROM emails
    GROUP BY date(processed_at)
    ORDER BY day DESC
  `;
  return all(query);
}

// جلب قائمة الشركات الفريدة للفلترة
async function getCompaniesList() {
  const rows = await all("SELECT DISTINCT company FROM emails WHERE company IS NOT NULL AND company != '' AND company != 'غير محدد' ORDER BY company ASC");
  return rows.map(r => r.company);
}

// ---------------- Candidate Profile Database Methods ---------------- //

// جلب الملف المهني الحالي للمرشح
async function getCandidateProfile() {
  const row = await get('SELECT * FROM candidate_profile ORDER BY id DESC LIMIT 1');
  if (!row) return null;
  return {
    ...row,
    links: row.links_json ? JSON.parse(row.links_json) : [],
    skills: row.skills_json ? JSON.parse(row.skills_json) : [],
    all_skills_flat: row.all_skills_flat_json ? JSON.parse(row.all_skills_flat_json) : [],
    experience: row.experience_json ? JSON.parse(row.experience_json) : [],
    education: row.education_json ? JSON.parse(row.education_json) : [],
    certifications: row.certifications_json ? JSON.parse(row.certifications_json) : [],
    projects: row.projects_json ? JSON.parse(row.projects_json) : [],
    languages: row.languages_json ? JSON.parse(row.languages_json) : [],
    work_types: row.work_types_json ? JSON.parse(row.work_types_json) : ['remote', 'on-site', 'hybrid'],
    answers_db: row.answers_db_json ? JSON.parse(row.answers_db_json) : {}
  };
}

// حفظ أو تحديث الملف المهني المستخرج من الـ CV
async function saveOrUpdateCandidateProfile(data) {
  const existing = await get('SELECT id, original_cv_path, original_cv_filename, min_salary, work_types_json, preferred_locations FROM candidate_profile ORDER BY id DESC LIMIT 1');

  const min_salary = data.min_salary !== undefined ? data.min_salary : (existing?.min_salary ?? 2000);
  const work_types_json = data.work_types ? JSON.stringify(data.work_types) : (existing?.work_types_json || '["remote","on-site","hybrid"]');
  const preferred_locations = data.preferred_locations || existing?.preferred_locations || 'جميع دول العالم للعمل عن بعد / Remote Worldwide';
  const original_cv_path = data.original_cv_path || existing?.original_cv_path || '';
  const original_cv_filename = data.original_cv_filename || existing?.original_cv_filename || '';

  const params = [
    data.full_name || '',
    data.headline || '',
    data.email || '',
    data.phone || '',
    data.location || '',
    JSON.stringify(data.links || []),
    data.summary || '',
    JSON.stringify(data.skills || []),
    JSON.stringify(data.all_skills_flat || []),
    JSON.stringify(data.experience || []),
    JSON.stringify(data.education || []),
    JSON.stringify(data.certifications || []),
    JSON.stringify(data.projects || []),
    JSON.stringify(data.languages || []),
    data.raw_text || '',
    data.years_of_experience || 0,
    min_salary,
    work_types_json,
    preferred_locations,
    data.target_role || data.headline || '',
    JSON.stringify(data.answers_db || {}),
    original_cv_path,
    original_cv_filename,
    data.is_confirmed ? 1 : 0
  ];

  if (existing) {
    const sql = `
      UPDATE candidate_profile SET
        full_name = ?,
        headline = ?,
        email = ?,
        phone = ?,
        location = ?,
        links_json = ?,
        summary = ?,
        skills_json = ?,
        all_skills_flat_json = ?,
        experience_json = ?,
        education_json = ?,
        certifications_json = ?,
        projects_json = ?,
        languages_json = ?,
        raw_text = ?,
        years_of_experience = ?,
        min_salary = ?,
        work_types_json = ?,
        preferred_locations = ?,
        target_role = ?,
        answers_db_json = ?,
        original_cv_path = ?,
        original_cv_filename = ?,
        is_confirmed = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    await run(sql, [...params, existing.id]);
    return existing.id;
  } else {
    const sql = `
      INSERT INTO candidate_profile (
        full_name, headline, email, phone, location, links_json,
        summary, skills_json, all_skills_flat_json, experience_json, education_json,
        certifications_json, projects_json, languages_json, raw_text,
        years_of_experience, min_salary, work_types_json, preferred_locations, target_role,
        answers_db_json, original_cv_path, original_cv_filename, is_confirmed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const res = await run(sql, params);
    return res.lastID;
  }
}

// تحديث التفضيلات المهنية والخيارات
async function updateCandidatePreferences({ min_salary, work_types, preferred_locations, target_role, answers_db, is_confirmed }) {
  const existing = await get('SELECT id FROM candidate_profile ORDER BY id DESC LIMIT 1');
  if (!existing) {
    throw new Error('لا يوجد ملف مهني مسجل لتحديث تفضيلاته. يرجى رفع الـ CV أولاً.');
  }

  const updates = [];
  const params = [];

  if (min_salary !== undefined) {
    updates.push('min_salary = ?');
    params.push(Number(min_salary));
  }
  if (work_types !== undefined) {
    updates.push('work_types_json = ?');
    params.push(JSON.stringify(work_types));
  }
  if (preferred_locations !== undefined) {
    updates.push('preferred_locations = ?');
    params.push(preferred_locations);
  }
  if (target_role !== undefined) {
    updates.push('target_role = ?');
    params.push(target_role);
  }
  if (answers_db !== undefined) {
    updates.push('answers_db_json = ?');
    params.push(JSON.stringify(answers_db));
  }
  if (is_confirmed !== undefined) {
    updates.push('is_confirmed = ?');
    params.push(is_confirmed ? 1 : 0);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(existing.id);

  const sql = `UPDATE candidate_profile SET ${updates.join(', ')} WHERE id = ?`;
  await run(sql, params);
  return getCandidateProfile();
}

// ---------------- Job Listings & Deduplication Methods ---------------- //

// التحقق من وجود الوظيفة عبر البصمة الرقمية لمنع التكرار
async function isJobDuplicate(fingerprint) {
  const row = await get('SELECT id FROM job_listings WHERE fingerprint = ?', [fingerprint]);
  return !!row;
}

// ---------------- Job Sources Management Methods ---------------- //

// جلب كافة مصادر الوظائف
async function getJobSources() {
  return all('SELECT * FROM job_sources ORDER BY id ASC');
}

// جلب مصدر محدد
async function getJobSourceById(id) {
  return get('SELECT * FROM job_sources WHERE id = ?', [id]);
}

// جلب المصادر المفعلة فقط
async function getActiveSources() {
  return all('SELECT * FROM job_sources WHERE is_active = 1 ORDER BY id ASC');
}

// إضافة مصدر وظائف جديد
async function createJobSource({ name, url, type = 'api', api_endpoint = null, is_active = 1 }) {
  const sql = `
    INSERT INTO job_sources (name, url, type, api_endpoint, is_active)
    VALUES (?, ?, ?, ?, ?)
  `;
  const res = await run(sql, [name.trim(), url.trim(), type, api_endpoint ? api_endpoint.trim() : null, is_active ? 1 : 0]);
  return getJobSourceById(res.lastID);
}

// تعديل مصدر وظائف
async function updateJobSource(id, { name, url, type, api_endpoint, is_active }) {
  const existing = await getJobSourceById(id);
  if (!existing) throw new Error('مصدر الوظائف غير موجود.');

  const sql = `
    UPDATE job_sources SET
      name = COALESCE(?, name),
      url = COALESCE(?, url),
      type = COALESCE(?, type),
      api_endpoint = ?,
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  await run(sql, [
    name !== undefined ? name.trim() : null,
    url !== undefined ? url.trim() : null,
    type !== undefined ? type : null,
    api_endpoint !== undefined ? (api_endpoint ? api_endpoint.trim() : null) : existing.api_endpoint,
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    id
  ]);
  return getJobSourceById(id);
}

// تفعيل / تعطيل مصدر
async function toggleJobSource(id) {
  const src = await getJobSourceById(id);
  if (!src) throw new Error('مصدر الوظائف غير موجود.');
  const newStatus = src.is_active ? 0 : 1;
  await run('UPDATE job_sources SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newStatus, id]);
  return getJobSourceById(id);
}

// حذف مصدر وظائف
async function deleteJobSource(id) {
  return run('DELETE FROM job_sources WHERE id = ?', [id]);
}

// تحديث إحصائيات الجلب لمصدر معين
async function updateJobSourceStats(sourceName, { fetchedCount = 0, validCount = 0, duplicatesCount = 0 } = {}) {
  const sql = `
    UPDATE job_sources SET
      last_fetch_at = CURRENT_TIMESTAMP,
      total_fetched = total_fetched + ?,
      valid_jobs = valid_jobs + ?,
      duplicates_count = duplicates_count + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE name LIKE ? OR name LIKE ?
  `;
  return run(sql, [fetchedCount, validCount, duplicatesCount, `%${sourceName}%`, sourceName]);
}

// ---------------- Job Listings & Deduplication Methods ---------------- //

// التحقق من وجود الوظيفة عبر البصمة الرقمية لمنع التكرار
async function isJobDuplicate(fingerprint) {
  const row = await get('SELECT id FROM job_listings WHERE fingerprint = ?', [fingerprint]);
  return !!row;
}

// فحص وتحديث الوظائف المنتهية
async function checkAndExpireJobs() {
  const nowStr = new Date().toISOString();
  await run(`
    UPDATE job_listings
    SET application_status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
    WHERE expires_at IS NOT NULL
      AND expires_at != ''
      AND expires_at != 'Not specified'
      AND expires_at != 'غير محدد'
      AND datetime(expires_at) < datetime('now')
      AND application_status NOT IN ('APPLIED_MANUALLY', 'EXPIRED')
  `);
}

// حفظ وظيفة جديدة واحدة مع منع التكرار
async function saveJobListing(job) {
  const sql = `
    INSERT INTO job_listings (
      fingerprint, source, source_job_id, company, title, location,
      work_type, salary_raw, salary_min, salary_max, url, apply_url,
      description, tags_json, published_at, expires_at, employment_type, application_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    job.fingerprint,
    job.source || 'Unknown',
    job.source_job_id || null,
    job.company || 'Unknown Company',
    job.title || 'Untitled Role',
    job.location || 'Remote',
    job.work_type || 'remote',
    job.salary_raw || null,
    job.salary_min || null,
    job.salary_max || null,
    job.url,
    job.apply_url || job.url,
    job.description || '',
    JSON.stringify(job.tags || []),
    job.published_at || new Date().toISOString(),
    job.expires_at || null,
    job.employment_type || 'Full-time',
    job.application_status || 'NEW'
  ];

  try {
    const res = await run(sql, params);
    return { inserted: true, id: res.lastID };
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

// حفظ دفعة وظائف مع إحصائية الدقة والتكرار
async function saveJobListingsBatch(jobs) {
  let newlyInserted = 0;
  let duplicatesSkipped = 0;

  for (const job of jobs) {
    if (!job.fingerprint) continue;
    const exists = await isJobDuplicate(job.fingerprint);
    if (exists) {
      duplicatesSkipped++;
    } else {
      const res = await saveJobListing(job);
      if (res.inserted) newlyInserted++;
      else duplicatesSkipped++;
    }
  }

  return {
    totalReceived: jobs.length,
    newlyInserted,
    duplicatesSkipped
  };
}

// جلب الوظائف مع الفلاتر والبحث والترتيب
async function getJobListings({
  search,
  company,
  location,
  work_type,
  source,
  min_score,
  status,
  sort_by = 'newest',
  limit = 50,
  offset = 0,
  include_expired = false
} = {}) {
  // فحص تلقائي لتحديث المنتهية أولاً
  await checkAndExpireJobs();

  let conditions = [];
  let params = [];

  // فلترة حسب الحالة
  if (status && status !== 'all') {
    if (status === 'active_only') {
      conditions.push("application_status NOT IN ('EXPIRED', 'REJECTED')");
    } else {
      conditions.push('UPPER(application_status) = UPPER(?)');
      params.push(status);
    }
  } else if (!include_expired) {
    // الوضع الافتراضي إخفاء المنتهية إلا إذا طُلبت صراحة
    conditions.push("application_status != 'EXPIRED'");
  }

  if (work_type && work_type !== 'all') {
    conditions.push('work_type = ?');
    params.push(work_type);
  }

  if (source && source !== 'all') {
    conditions.push('source = ?');
    params.push(source);
  }

  if (company && company !== 'all') {
    conditions.push('company LIKE ?');
    params.push(`%${company}%`);
  }

  if (location && location !== 'all') {
    conditions.push('location LIKE ?');
    params.push(`%${location}%`);
  }

  if (min_score) {
    conditions.push('match_score >= ?');
    params.push(Number(min_score));
  }

  if (search) {
    conditions.push('(title LIKE ? OR company LIKE ? OR description LIKE ? OR location LIKE ? OR title_ar LIKE ? OR description_ar LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term, term, term, term);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // الترتيب
  let orderClause = 'ORDER BY id DESC';
  if (sort_by === 'match_score' || sort_by === 'highest_score') {
    orderClause = 'ORDER BY match_score DESC, id DESC';
  } else if (sort_by === 'newest') {
    orderClause = 'ORDER BY COALESCE(published_at, created_at) DESC, id DESC';
  } else if (sort_by === 'deadline') {
    orderClause = 'ORDER BY CASE WHEN expires_at IS NULL OR expires_at = "" THEN 1 ELSE 0 END, expires_at ASC, id DESC';
  } else if (sort_by === 'salary') {
    orderClause = 'ORDER BY COALESCE(salary_min, salary_max, 0) DESC, id DESC';
  } else if (sort_by === 'company') {
    orderClause = 'ORDER BY company ASC';
  }

  const query = `
    SELECT * FROM job_listings
    ${whereClause}
    ${orderClause}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = await all(query, params);
  return rows.map(r => formatJobRow(r));
}

// دالة مساعدة لتنسيق وتفريغ كائنات الـ JSON
function formatJobRow(r) {
  if (!r) return null;
  return {
    ...r,
    tags: r.tags_json ? safeJsonParse(r.tags_json, []) : [],
    matched_skills: r.matched_skills_json ? safeJsonParse(r.matched_skills_json, []) : [],
    missing_skills: r.missing_skills_json ? safeJsonParse(r.missing_skills_json, []) : [],
    match_strengths: r.match_strengths_json ? safeJsonParse(r.match_strengths_json, []) : [],
    match_weaknesses: r.match_weaknesses_json ? safeJsonParse(r.match_weaknesses_json, []) : [],
    responsibilities_ar: r.responsibilities_ar_json ? safeJsonParse(r.responsibilities_ar_json, []) : [],
    responsibilities_en: r.responsibilities_en_json ? safeJsonParse(r.responsibilities_en_json, []) : [],
    req_mandatory: r.req_mandatory_json ? safeJsonParse(r.req_mandatory_json, []) : [],
    req_preferred: r.req_preferred_json ? safeJsonParse(r.req_preferred_json, []) : [],
    benefits: r.benefits_json ? safeJsonParse(r.benefits_json, []) : []
  };
}

function safeJsonParse(str, fallback = []) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// جلب تفاصيل وظيفة واحدة بالمعرف
async function getJobListingById(id) {
  const row = await get('SELECT * FROM job_listings WHERE id = ?', [id]);
  return formatJobRow(row);
}

// إحصائيات الوظائف والتقديمات الشاملة للوحة التحكم
async function getJobStats() {
  await checkAndExpireJobs();

  const stats = await get(`
    SELECT
      COUNT(*) as total_found,
      SUM(CASE WHEN UPPER(application_status) = 'NEW' OR application_status = 'discovered' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN (match_score >= 60 AND UPPER(application_status) NOT IN ('REJECTED', 'EXPIRED')) OR UPPER(application_status) = 'MATCHED' THEN 1 ELSE 0 END) as matched_count,
      SUM(CASE WHEN match_score >= 80 AND UPPER(application_status) NOT IN ('REJECTED', 'EXPIRED') THEN 1 ELSE 0 END) as high_match_count,
      SUM(CASE WHEN tailored_cv_path IS NOT NULL AND tailored_cv_path != '' THEN 1 ELSE 0 END) as cvs_prepared,
      SUM(CASE WHEN (cover_letter IS NOT NULL AND cover_letter != '') OR (cover_letter_ar IS NOT NULL AND cover_letter_ar != '') OR (cover_letter_en IS NOT NULL AND cover_letter_en != '') THEN 1 ELSE 0 END) as cover_letters_prepared,
      SUM(CASE WHEN UPPER(application_status) = 'READY_TO_APPLY' OR UPPER(application_status) = 'CV_READY' THEN 1 ELSE 0 END) as ready_to_apply,
      SUM(CASE WHEN UPPER(application_status) = 'APPLIED_MANUALLY' OR application_status = 'applied' OR applied_at IS NOT NULL THEN 1 ELSE 0 END) as manually_applied,
      SUM(CASE WHEN UPPER(application_status) = 'EXPIRED' THEN 1 ELSE 0 END) as expired_count,
      SUM(CASE WHEN UPPER(application_status) = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count,
      COUNT(DISTINCT company) as distinct_companies
    FROM job_listings
  `);

  return {
    totalFound: stats?.total_found || 0,
    newJobs: stats?.new_count || 0,
    matchingJobs: stats?.matched_count || 0,
    highMatchJobs: stats?.high_match_count || 0,
    cvsPrepared: stats?.cvs_prepared || 0,
    coverLettersPrepared: stats?.cover_letters_prepared || 0,
    readyToApply: stats?.ready_to_apply || 0,
    manuallyApplied: stats?.manually_applied || 0,
    expiredJobs: stats?.expired_count || 0,
    rejectedJobs: stats?.rejected_count || 0,
    distinctCompanies: stats?.distinct_companies || 0
  };
}

// تحديث نتائج المطابقة الذكية للوظيفة
async function updateJobMatchResults(jobId, {
  match_score,
  matched_skills,
  missing_skills,
  match_reasons,
  match_strengths,
  match_weaknesses,
  application_status,
  ai_summary_ar,
  title_ar,
  description_ar,
  responsibilities_ar,
  responsibilities_en,
  req_mandatory,
  req_preferred,
  req_experience,
  req_education,
  req_languages,
  req_certifications,
  benefits
}) {
  const sql = `
    UPDATE job_listings SET
      match_score = COALESCE(?, match_score),
      matched_skills_json = COALESCE(?, matched_skills_json),
      missing_skills_json = COALESCE(?, missing_skills_json),
      match_reasons = COALESCE(?, match_reasons),
      match_strengths_json = COALESCE(?, match_strengths_json),
      match_weaknesses_json = COALESCE(?, match_weaknesses_json),
      application_status = COALESCE(?, application_status),
      ai_summary_ar = COALESCE(?, ai_summary_ar),
      title_ar = COALESCE(?, title_ar),
      description_ar = COALESCE(?, description_ar),
      responsibilities_ar_json = COALESCE(?, responsibilities_ar_json),
      responsibilities_en_json = COALESCE(?, responsibilities_en_json),
      req_mandatory_json = COALESCE(?, req_mandatory_json),
      req_preferred_json = COALESCE(?, req_preferred_json),
      req_experience = COALESCE(?, req_experience),
      req_education = COALESCE(?, req_education),
      req_languages = COALESCE(?, req_languages),
      req_certifications = COALESCE(?, req_certifications),
      benefits_json = COALESCE(?, benefits_json),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  const params = [
    match_score !== undefined ? match_score : null,
    matched_skills ? JSON.stringify(matched_skills) : null,
    missing_skills ? JSON.stringify(missing_skills) : null,
    match_reasons || null,
    match_strengths ? JSON.stringify(match_strengths) : null,
    match_weaknesses ? JSON.stringify(match_weaknesses) : null,
    application_status || null,
    ai_summary_ar || null,
    title_ar || null,
    description_ar || null,
    responsibilities_ar ? JSON.stringify(responsibilities_ar) : null,
    responsibilities_en ? JSON.stringify(responsibilities_en) : null,
    req_mandatory ? JSON.stringify(req_mandatory) : null,
    req_preferred ? JSON.stringify(req_preferred) : null,
    req_experience || null,
    req_education || null,
    req_languages || null,
    req_certifications || null,
    benefits ? JSON.stringify(benefits) : null,
    jobId
  ];
  return run(sql, params);
}

// حفظ مستندات التقديم المخصصة (CV + Cover Letter باللغتين)
async function updateJobTailoredDocs(jobId, { tailored_cv_path, cover_letter_en, cover_letter_ar, cover_letter }) {
  const sql = `
    UPDATE job_listings SET
      tailored_cv_path = COALESCE(?, tailored_cv_path),
      cover_letter = COALESCE(?, cover_letter),
      cover_letter_en = COALESCE(?, cover_letter_en),
      cover_letter_ar = COALESCE(?, cover_letter_ar),
      application_status = CASE WHEN application_status IN ('NEW', 'discovered', 'MATCHED') THEN 'CV_READY' ELSE application_status END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  return run(sql, [tailored_cv_path || null, cover_letter || cover_letter_en || null, cover_letter_en || null, cover_letter_ar || null, jobId]);
}

// ---------------- Manual Applications Methods ---------------- //

// توثيق التقديم اليدوي الحصري للمستخدم
async function markJobAppliedManually(jobId, { notes = '' } = {}) {
  const job = await getJobListingById(jobId);
  if (!job) throw new Error('الوظيفة غير موجودة.');

  const now = new Date().toISOString();

  // تحديث حالة الوظيفة في جدول الوظائف
  await run(`
    UPDATE job_listings SET
      application_status = 'APPLIED_MANUALLY',
      applied_at = ?,
      manual_application_notes = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [now, notes, jobId]);

  // إدراج سجل التقديم اليدوي
  const sql = `
    INSERT INTO manual_applications (
      job_id, company, title, job_url, applied_at, tailored_cv_path, cover_letter_used, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    job.id,
    job.company,
    job.title,
    job.url,
    now,
    job.tailored_cv_path || '',
    job.cover_letter_ar || job.cover_letter_en || job.cover_letter || '',
    notes
  ];
  const res = await run(sql, params);

  return {
    success: true,
    applicationId: res.lastID,
    jobId: job.id,
    applied_at: now
  };
}

// جلب سجل التقديمات اليدوية
async function getManualApplications() {
  const sql = `
    SELECT m.*, j.location, j.work_type, j.source, j.match_score, j.salary_raw
    FROM manual_applications m
    LEFT JOIN job_listings j ON m.job_id = j.id
    ORDER BY m.applied_at DESC, m.id DESC
  `;
  return all(sql);
}

// تحديث حالة الوظيفة يدوياً
async function updateJobApplicationStatus(jobId, status) {
  let sql = 'UPDATE job_listings SET application_status = ?, updated_at = CURRENT_TIMESTAMP';
  const params = [status];

  if (status === 'APPLIED_MANUALLY' || status === 'applied') {
    sql += ', applied_at = CURRENT_TIMESTAMP';
  }
  sql += ' WHERE id = ?';
  params.push(jobId);

  return run(sql, params);
}

// جلب الوظائف التي لم يتم تقييمها بعد بالمطابقة الذكية
async function getUnanalyzedJobListings(limit = 20) {
  const query = `
    SELECT * FROM job_listings
    WHERE (match_score = 0 OR match_score IS NULL OR ai_summary_ar IS NULL)
      AND application_status NOT IN ('APPLIED_MANUALLY', 'applied', 'REJECTED', 'EXPIRED')
    ORDER BY id DESC
    LIMIT ?
  `;
  const rows = await all(query, [limit]);
  return rows.map(r => formatJobRow(r));
}

// إعادة تعيين جميع التقديمات السابقة
async function resetAppliedJobs() {
  return run("UPDATE job_listings SET application_status = 'NEW', applied_at = NULL");
}

// تحديث وحفظ خطاب التقديم المعدل
async function updateJobCoverLetter(jobId, { cover_letter_en, cover_letter_ar, cover_letter }) {
  return run(`
    UPDATE job_listings SET
      cover_letter = COALESCE(?, cover_letter),
      cover_letter_en = COALESCE(?, cover_letter_en),
      cover_letter_ar = COALESCE(?, cover_letter_ar),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [cover_letter || cover_letter_en || null, cover_letter_en || null, cover_letter_ar || null, jobId]);
}

module.exports = {
  db,
  all,
  get,
  run,
  isMessageProcessed,
  saveEmail,
  logEvent,
  getStats,
  getEmails,
  getHistoryGrouped,
  getCompaniesList,
  getCandidateProfile,
  saveOrUpdateCandidateProfile,
  updateCandidatePreferences,
  getJobSources,
  getJobSourceById,
  getActiveSources,
  createJobSource,
  updateJobSource,
  toggleJobSource,
  deleteJobSource,
  updateJobSourceStats,
  isJobDuplicate,
  checkAndExpireJobs,
  saveJobListing,
  saveJobListingsBatch,
  getJobListings,
  getUnanalyzedJobListings,
  getJobListingById,
  getJobStats,
  updateJobMatchResults,
  updateJobTailoredDocs,
  markJobAppliedManually,
  getManualApplications,
  updateJobApplicationStatus,
  resetAppliedJobs,
  updateJobCoverLetter
};





