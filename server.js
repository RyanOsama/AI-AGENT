const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const multer = require('multer');
require('dotenv').config();

const db = require('./database');
const { processNewEmails } = require('./gmail_service');
const { extractRawTextFromFile, parseCvToProfile } = require('./cv_parser');
const { runJobSourcingCycle } = require('./job_sourcing');
const { matchJobWithCandidate, matchBatchOfJobs } = require('./job_matching');
const { tailorCvAndCoverLetter } = require('./cv_tailor');
const { processJobApplication, autoApplyEligibleJobs, batchAutoApplyMatchingJobs } = require('./auto_apply');
const { browserApplicant } = require('./browser_applicant');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES, 10) || 10;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// إعداد تخزين السير الذاتية الأصلية لحفظها دون أي تعديل
const cvStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads', 'cv');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `Original_${uniqueSuffix}_${safeName}`);
  }
});

const upload = multer({
  storage: cvStorage,
  limits: { fileSize: 15 * 1024 * 1024 } // حتى 15MB
});

// متغيرات حالة النظام
let lastCheckTime = null;
let isChecking = false;
let checkCount = 0;

// دالة فحص البريد مع الحماية من التداخل
async function runEmailCheck(max = 15) {
  if (isChecking) {
    console.log('دورة فحص أخرى قيد العمل حالياً، تخطي...');
    return { status: 'busy' };
  }

  isChecking = true;
  lastCheckTime = new Date().toISOString();
  checkCount++;

  try {
    console.log(`[${new Date().toLocaleTimeString('ar-EG')}] بدء دورة فحص البريد التلقائية #${checkCount}...`);
    const result = await processNewEmails(max);
    console.log(`اكتمل الفحص: تمت معالجة ${result.processedCount} رسالة جديدة.`);
    return { status: 'success', ...result };
  } catch (err) {
    console.error('خطأ أثناء دورة الفحص:', err);
    return { status: 'error', error: err.message };
  } finally {
    isChecking = false;
  }
}

// ---------------- API Endpoints ---------------- //

// إحصائيات النظام
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      ...stats,
      lastCheckTime,
      isChecking,
      checkInterval: CHECK_INTERVAL_MINUTES
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب الرسائل مع الفلاتر
app.get('/api/emails', async (req, res) => {
  try {
    const { priority, company, search, date, limit = 50, offset = 0 } = req.query;
    const emails = await db.getEmails({
      priority,
      company,
      search,
      date,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب سجل التواريخ المجمعة
app.get('/api/history', async (req, res) => {
  try {
    const history = await db.getHistoryGrouped();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب قائمة الشركات
app.get('/api/companies', async (req, res) => {
  try {
    const companies = await db.getCompaniesList();
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تشغيل فحص يدوي فوري للبريد
app.post('/api/check-now', async (req, res) => {
  try {
    const result = await runEmailCheck(15);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب سجلات النظام
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM system_logs ORDER BY id DESC LIMIT 50');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Candidate Profile & Job Search Endpoints ---------------- //

// جلب الملف المهني الحالي
app.get('/api/candidate/profile', async (req, res) => {
  try {
    const profile = await db.getCandidateProfile();
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// رفع وتحليل السيرة الذاتية الأساسية
app.post('/api/candidate/upload-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'يرجى اختيار ملف سيرة ذاتية صالح (PDF أو TXT).' });
    }

    console.log(`[ProfileExtractor] تم استلام ملف السيرة الذاتية: ${req.file.originalname}`);

    // استخراج النص من الملف
    const rawText = await extractRawTextFromFile(req.file.path);
    if (!rawText || rawText.trim().length < 40) {
      return res.status(400).json({
        success: false,
        error: 'تعذر قراءة النص من الملف. يرجى التأكد من أن ملف PDF يحتوي على نصوص وليس صوراً ممسوحة فقط.'
      });
    }

    // استخراج البيانات المهيكلة بالذكاء الاصطناعي مع منع الفبركة
    const structuredProfile = await parseCvToProfile(rawText);

    // حفظ في قاعدة البيانات مع ربط مسار الملف الأصلي
    const profileToSave = {
      ...structuredProfile,
      original_cv_path: req.file.path,
      original_cv_filename: req.file.originalname,
      is_confirmed: 0 // يتطلب مراجعة واعتماد المستخدم
    };

    const profileId = await db.saveOrUpdateCandidateProfile(profileToSave);

    await db.logEvent('INFO', 'تم رفع وتحليل السيرة الذاتية بنجاح', `المرشح: ${structuredProfile.full_name} (${structuredProfile.headline})`);

    const fullProfile = await db.getCandidateProfile();
    res.json({
      success: true,
      message: 'تم تحليل السيرة الذاتية واستخراج الملف المهني بنجاح.',
      profileId,
      profile: fullProfile
    });
  } catch (err) {
    console.error('خطأ أثناء معالجة السيرة الذاتية:', err);
    await db.logEvent('ERROR', 'فشل في رفع أو تحليل السيرة الذاتية', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحديث التفضيلات المهنية (الراتب، أنواع العمل، التأكيد)
app.post('/api/candidate/preferences', async (req, res) => {
  try {
    const { min_salary, work_types, preferred_locations, target_role, answers_db, is_confirmed } = req.body;
    const updated = await db.updateCandidatePreferences({
      min_salary,
      work_types,
      preferred_locations,
      target_role,
      answers_db,
      is_confirmed
    });

    await db.logEvent('INFO', 'تم تحديث تفضيلات التوظيف الذكي', `الحد الأدنى للراتب: $${updated.min_salary} | أنواع العمل: ${JSON.stringify(updated.work_types)}`);

    res.json({ success: true, profile: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحميل أو معاينة السيرة الذاتية الأصلية
app.get('/api/candidate/download-cv', async (req, res) => {
  try {
    const profile = await db.getCandidateProfile();
    if (!profile || !profile.original_cv_path || !fs.existsSync(profile.original_cv_path)) {
      return res.status(404).json({ error: 'لم يتم العثور على ملف السيرة الذاتية الأصلي.' });
    }
    res.download(profile.original_cv_path, profile.original_cv_filename || 'original_cv.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Job Sources Management Endpoints ---------------- //

// جلب قائمة كافة مصادر الوظائف وإحصائياتها
app.get('/api/job-sources', async (req, res) => {
  try {
    const sources = await db.getJobSources();
    res.json({ success: true, count: sources.length, sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب مصدر وظائف محدد
app.get('/api/job-sources/:id', async (req, res) => {
  try {
    const source = await db.getJobSourceById(req.params.id);
    if (!source) return res.status(404).json({ success: false, error: 'المصدر غير موجود' });
    res.json({ success: true, source });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// إضافة مصدر وظائف جديد
app.post('/api/job-sources', async (req, res) => {
  try {
    const { name, url, type = 'api', api_endpoint, is_active = 1 } = req.body;
    if (!name || !url) {
      return res.status(400).json({ success: false, error: 'يرجى تقديم اسم المصدر والرابط.' });
    }
    const created = await db.createJobSource({ name, url, type, api_endpoint, is_active });
    await db.logEvent('INFO', 'إضافة مصدر وظائف جديد', `تمت إضافة المصدر: ${name} (${type})`);
    res.json({ success: true, message: 'تمت إضافة مصدر الوظائف بنجاح.', source: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تعديل مصدر وظائف
app.put('/api/job-sources/:id', async (req, res) => {
  try {
    const { name, url, type, api_endpoint, is_active } = req.body;
    const updated = await db.updateJobSource(req.params.id, { name, url, type, api_endpoint, is_active });
    res.json({ success: true, message: 'تم تحديث مصدر الوظائف بنجاح.', source: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تفعيل / تعطيل مصدر وظائف
app.post('/api/job-sources/:id/toggle', async (req, res) => {
  try {
    const updated = await db.toggleJobSource(req.params.id);
    await db.logEvent('INFO', 'تغيير حالة مصدر الوظائف', `المصدر #${req.params.id} (${updated.name}) أصبح: ${updated.is_active ? 'مفعل' : 'معطل'}`);
    res.json({ success: true, message: `تم ${updated.is_active ? 'تفعيل' : 'تعطيل'} المصدر بنجاح.`, source: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// حذف مصدر وظائف
app.delete('/api/job-sources/:id', async (req, res) => {
  try {
    await db.deleteJobSource(req.params.id);
    await db.logEvent('WARNING', 'حذف مصدر وظائف', `تم حذف المصدر #${req.params.id}`);
    res.json({ success: true, message: 'تم حذف مصدر الوظائف بنجاح.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- Job Search & Sourcing Endpoints ---------------- //

// جلب إحصائيات الوظائف الشاملة
app.get('/api/jobs/stats', async (req, res) => {
  try {
    const stats = await db.getJobStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب قائمة الوظائف مع الفلترة والبحث والترتيب
app.get('/api/jobs', async (req, res) => {
  try {
    const {
      status,
      work_type,
      source,
      search,
      company,
      location,
      min_score,
      sort_by = 'newest',
      include_expired,
      limit = 50,
      offset = 0
    } = req.query;

    const jobs = await db.getJobListings({
      status,
      work_type,
      source,
      search,
      company,
      location,
      min_score: min_score ? parseInt(min_score, 10) : undefined,
      sort_by,
      include_expired: include_expired === 'true' || include_expired === true,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
    res.json({ success: true, count: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب تفاصيل وظيفة محددة بالمعرف
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'الوظيفة غير موجودة' });
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تشغيل جلب الوظائف يدوياً وفورياً حصراً من المصادر المفعلة
app.post('/api/jobs/fetch-now', async (req, res) => {
  try {
    const result = await runJobSourcingCycle();
    const stats = await db.getJobStats();
    res.json({ success: true, ...result, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تشغيل المطابقة والتقييم الذكي لدفعة من الوظائف
app.post('/api/jobs/match-all', async (req, res) => {
  try {
    const { limit = 15 } = req.body;
    const result = await matchBatchOfJobs(parseInt(limit, 10));
    const stats = await db.getJobStats();
    res.json({ success: true, ...result, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحليل ومطابقة وظيفة واحدة محددة وترجمتها
app.post('/api/jobs/:id/match', async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'الوظيفة غير موجودة' });

    const candidateProfile = await db.getCandidateProfile();
    if (!candidateProfile) return res.status(400).json({ success: false, error: 'يرجى رفع ملف المرشح أولاً' });

    const matchResult = await matchJobWithCandidate(job, candidateProfile);
    const newStatus = matchResult.match_score >= 60 ? 'MATCHED' : 'NEW';

    await db.updateJobMatchResults(job.id, {
      match_score: matchResult.match_score,
      matched_skills: matchResult.matched_skills,
      missing_skills: matchResult.missing_skills,
      match_reasons: matchResult.match_reasons,
      match_strengths: matchResult.match_strengths,
      match_weaknesses: matchResult.match_weaknesses,
      application_status: newStatus,
      ai_summary_ar: matchResult.ai_summary_ar,
      title_ar: matchResult.title_ar,
      description_ar: matchResult.description_ar,
      responsibilities_ar: matchResult.responsibilities_ar,
      responsibilities_en: matchResult.responsibilities_en,
      req_mandatory: matchResult.req_mandatory,
      req_preferred: matchResult.req_preferred,
      req_experience: matchResult.req_experience,
      req_education: matchResult.req_education,
      req_languages: matchResult.req_languages,
      req_certifications: matchResult.req_certifications,
      benefits: matchResult.benefits
    });

    const updatedJob = await db.getJobListingById(job.id);
    res.json({ success: true, matchResult, job: updatedJob });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحليل وترجمة تفاصيل الوظيفة عند الطلب
app.post('/api/jobs/:id/translate-analyze', async (req, res) => {
  try {
    let job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'الوظيفة غير موجودة' });

    const candidateProfile = await db.getCandidateProfile();
    if (!candidateProfile) return res.status(400).json({ success: false, error: 'يرجى رفع ملف المرشح أولاً' });

    if (!job.ai_summary_ar || !job.description_ar) {
      const matchResult = await matchJobWithCandidate(job, candidateProfile);
      await db.updateJobMatchResults(job.id, matchResult);
      job = await db.getJobListingById(job.id);
    }

    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- Tailored CV & Cover Letter Endpoints ---------------- //

// تخصيص السيرة الذاتية وخطاب التقديم (باللغتين) لوظيفة محددة
app.post(['/api/jobs/:id/prepare-cv', '/api/jobs/:id/tailor'], async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'الوظيفة غير موجودة' });

    const candidateProfile = await db.getCandidateProfile();
    if (!candidateProfile) return res.status(400).json({ success: false, error: 'يرجى رفع واعتماد ملف المرشح أولاً' });

    console.log(`[TailorAgent] تجهيز الـ CV و Cover Letter المخصص للوظيفة #${job.id} (${job.company} - ${job.title})...`);

    const result = await tailorCvAndCoverLetter(job, candidateProfile);

    await db.logEvent('INFO', 'تم توليد CV و Cover Letter مخصص', `الوظيفة #${job.id} في ${job.company}`);

    const updatedJob = await db.getJobListingById(job.id);
    const stats = await db.getJobStats();

    res.json({
      success: true,
      message: 'تم تجهيز السيرة الذاتية المخصصة وخطاب التقديم (إنجليزي وعربي) بنجاح.',
      pdfFilename: result.pdfFilename,
      downloadUrl: `/api/jobs/${job.id}/cv`,
      coverLetterPdfUrl: `/api/jobs/${job.id}/cover-letter-pdf`,
      coverLetterEn: result.coverLetterEn,
      coverLetterAr: result.coverLetterAr,
      coverLetter: result.coverLetter,
      job: updatedJob,
      stats
    });
  } catch (err) {
    console.error('خطأ في تخصيص الـ CV:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحميل الـ CV المخصص بصيغة PDF
app.get(['/api/jobs/:id/download-cv', '/api/jobs/:id/cv'], async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job || !job.tailored_cv_path || !fs.existsSync(job.tailored_cv_path)) {
      return res.status(404).json({ error: 'لم يتم العثور على ملف السيرة الذاتية المخصصة لهذه الوظيفة. يرجى الضغط على تجهيز الـ CV أولاً.' });
    }
    const safeFilename = path.basename(job.tailored_cv_path);
    res.download(job.tailored_cv_path, safeFilename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تحميل خطاب التقديم المخصص بصيغة PDF
app.get('/api/jobs/:id/cover-letter-pdf', async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ error: 'الوظيفة غير موجودة' });

    const clFileName = `cover_letter_job_${job.id}.pdf`;
    const clFilePath = path.join(__dirname, 'uploads', 'tailored_cvs', clFileName);

    if (fs.existsSync(clFilePath)) {
      return res.download(clFilePath, clFileName);
    }

    // إذا لم يكن مولداً مسبقاً، نولده فورياً
    const candidateProfile = await db.getCandidateProfile();
    const coverText = job.cover_letter_en || job.cover_letter || job.cover_letter_ar || 'Cover Letter';
    const { buildCoverLetterPdf } = require('./cv_tailor');

    await buildCoverLetterPdf({
      profile: candidateProfile || { full_name: 'Applicant' },
      job: job,
      coverLetterText: coverText,
      outputPath: clFilePath
    });

    res.download(clFilePath, clFileName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب نصوص خطاب التقديم المخصص
app.get('/api/jobs/:id/cover-letter', async (req, res) => {
  try {
    const job = await db.getJobListingById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'الوظيفة غير موجودة' });
    res.json({
      success: true,
      coverLetterEn: job.cover_letter_en || job.cover_letter || '',
      coverLetterAr: job.cover_letter_ar || '',
      coverLetter: job.cover_letter || job.cover_letter_en || ''
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// حفظ وتحديث خطاب التقديم المعدل من قبل المستخدم
app.post('/api/jobs/:id/cover-letter', async (req, res) => {
  try {
    const { cover_letter, cover_letter_en, cover_letter_ar } = req.body;
    await db.updateJobCoverLetter(req.params.id, {
      cover_letter,
      cover_letter_en,
      cover_letter_ar
    });
    const job = await db.getJobListingById(req.params.id);
    res.json({ success: true, message: 'تم حفظ خطاب التقديم المعدل بنجاح.', job });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- Manual Applications Workflow Endpoints ---------------- //

// تأكيد التقديم اليدوي للوظيفة (Mark as Applied)
app.post('/api/jobs/:id/mark-applied', async (req, res) => {
  try {
    const { notes = '' } = req.body;
    const result = await db.markJobAppliedManually(req.params.id, { notes });
    const updatedJob = await db.getJobListingById(req.params.id);
    const stats = await db.getJobStats();

    await db.logEvent('INFO', 'تأكيد تقديم يدوي', `قام المستخدم بتأكيد التقديم اليدوي للوظيفة #${req.params.id} (${updatedJob.company} - ${updatedJob.title})`);

    res.json({
      success: true,
      message: 'تم تسجيل وتوثيق تقديمك اليدوي للوظيفة بنجاح! 🎯',
      result,
      job: updatedJob,
      stats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب سجل كافة التقديمات اليدوية
app.get('/api/manual-applications', async (req, res) => {
  try {
    const applications = await db.getManualApplications();
    res.json({ success: true, count: applications.length, applications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تحديث حالة الوظيفة يدوياً من قبل المستخدم
app.post('/api/jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['NEW', 'MATCHED', 'CV_READY', 'READY_TO_APPLY', 'APPLIED_MANUALLY', 'REJECTED', 'EXPIRED'];
    if (!status || !allowedStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
    }

    await db.updateJobApplicationStatus(req.params.id, status.toUpperCase());
    const updatedJob = await db.getJobListingById(req.params.id);
    const stats = await db.getJobStats();

    await db.logEvent('INFO', 'تحديث حالة الوظيفة', `تم تغيير حالة الوظيفة #${req.params.id} إلى '${status}'`);

    res.json({ success: true, message: 'تم تحديث حالة الوظيفة بنجاح.', job: updatedJob, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// إعادة تعيين جميع التقديمات السابقة
app.post('/api/jobs/reset-applied', async (req, res) => {
  try {
    await db.resetAppliedJobs();
    await db.logEvent('WARNING', 'إعادة تعيين التقديمات', 'تم مسح سجل التقديمات السابقة وإعادتها لحالة جديدة بطلب المستخدم.');
    const stats = await db.getJobStats();
    res.json({ success: true, message: 'تم إلغاء جميع التقديمات السابقة وإعادتها للاستكشاف بنجاح.', stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// دورة البحث والمطابقة الذكية المجدولة (بدون أي تقديم تلقائي)
async function runJobHuntingCycle() {
  console.log(`\n[JobHuntingCycle] 🚀 بدء دورة البحث والمطابقة الذكية للمصادر المفعلة...`);
  try {
    // 1. استكشاف الوظائف الجديدة حصراً من المصادر المفعلة ومنع التكرار
    const sourcingRes = await runJobSourcingCycle();

    // 2. التحقق من وجود ملف مرشح
    const profile = await db.getCandidateProfile();
    if (!profile) {
      console.log('[JobHuntingCycle] بانتظار رفع ملف المرشح لبدء المطابقة.');
      return { sourcing: sourcingRes, matching: null };
    }

    // 3. مطابقة وتقييم الوظائف المكتشفة مع ملف المرشح والترجمة
    const matchingRes = await matchBatchOfJobs(15);

    console.log(`[JobHuntingCycle] ✅ اكتملت دورة الاستكشاف والتقييم: مكتشفة جديدة (${sourcingRes.newlyInserted}) | تم تقييمها ومطابقتها (${matchingRes.analyzedCount || 0})`);
    return { sourcing: sourcingRes, matching: matchingRes };
  } catch (err) {
    console.error('[JobHuntingCycle] خطأ في الدورة التلقائية:', err);
    await db.logEvent('ERROR', 'خطأ في دورة استكشاف الوظائف', err.message);
    return { error: err.message };
  }
}

// تشغيل دورة البحث والمطابقة فورياً بطلب المستخدم
app.post('/api/jobs/run-cycle', async (req, res) => {
  try {
    const cycleResult = await runJobHuntingCycle();
    const stats = await db.getJobStats();
    res.json({ success: true, cycleResult, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 خادم لوحة التحكم يعمل الآن على: http://localhost:${PORT}`);
  console.log(`⏱️ الجدولة التلقائية: فحص البريد كل ${CHECK_INTERVAL_MINUTES} دقائق.`);
  console.log(`======================================================\n`);

  // تشغيل الجدولة التلقائية للبريد (Cron)
  const cronExpression = `*/${CHECK_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpression, () => {
    console.log('⏰ تنبيه الجدولة: تشغيل الفحص الدوري للبريد...');
    runEmailCheck(15);
  });

  // تشغيل الجدولة التلقائية للبحث عن الوظائف والتقديم الآلي (كل 4 ساعات)
  const JOB_CHECK_HOURS = parseInt(process.env.JOB_CHECK_INTERVAL_HOURS, 10) || 4;
  cron.schedule(`0 */${JOB_CHECK_HOURS} * * *`, () => {
    console.log('⏰ تنبيه الجدولة: تشغيل الفحص الدوري المستقل للوظائف...');
    runJobHuntingCycle();
  });
});
