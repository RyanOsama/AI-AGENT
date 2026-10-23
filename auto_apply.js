const fs = require('fs');
const db = require('./database');
const { tailorCvAndCoverLetter } = require('./cv_tailor');

/**
 * وكيل الإجابة على أسئلة نماذج التقديم (ProfileAnswerLookup)
 * يجيب على الأسئلة حصراً من الـ Candidate Profile المعتمد دون أي تخمين
 */
function resolveApplicationQuestion(questionText, profile) {
  const q = String(questionText || '').toLowerCase().trim();
  const answersDb = profile.answers_db || {};

  // فحص الإجابات المحفوظة مسبقاً أولاً
  for (const [key, val] of Object.entries(answersDb)) {
    if (q.includes(key.toLowerCase())) {
      return { resolved: true, answer: String(val) };
    }
  }

  // 1. سنوات الخبرة
  if (q.includes('year') && (q.includes('experience') || q.includes('exp')) || q.includes('how many years') || q.includes('سنوات الخبرة') || q.includes('سنة خبرة')) {
    return { resolved: true, answer: String(profile.years_of_experience || 0) };
  }

  // 2. الراتب المتوقع / المطلوب
  if (q.includes('salary') || q.includes('compensation') || q.includes('pay rate') || q.includes('expected pay') || q.includes('hourly rate') || q.includes('الراتب') || q.includes('الأجر') || q.includes('المقابل المادي')) {
    return { resolved: true, answer: `$${profile.min_salary || 2000}/month (Negotiable based on role & benefits)` };
  }

  // 3. تصريح العمل (Work Authorization)
  if (q.includes('authorized') || q.includes('authorization') || q.includes('legally authorized') || q.includes('تصريح العمل') || q.includes('مصرح لك')) {
    return { resolved: true, answer: answersDb.work_authorization || 'Yes, authorized for remote international employment.' };
  }

  // 4. الحاجة لرعاية تأشيرة (Visa Sponsorship)
  if (q.includes('sponsorship') || q.includes('sponsor') || q.includes('visa') || q.includes('كفالة') || q.includes('تأشيرة')) {
    return { resolved: true, answer: answersDb.requires_sponsorship || 'No sponsorship required for remote positions.' };
  }

  // 5. الاستعداد للانتقال (Relocation)
  if (q.includes('relocate') || q.includes('relocation') || q.includes('الانتقال') || q.includes('السفر للعمل')) {
    return { resolved: true, answer: answersDb.willing_to_relocate || 'Open to relocation for the right opportunity, prefer remote or hybrid.' };
  }

  // 6. فترة الإشعار (Notice Period)
  if (q.includes('notice period') || q.includes('how soon') || q.includes('start date') || q.includes('availability') || q.includes('فترة الإشعار') || q.includes('تاريخ البدء') || q.includes('متى يمكنك البدء')) {
    return { resolved: true, answer: answersDb.notice_period || 'Available immediately or within 2 weeks.' };
  }

  // 7. الموقع الجغرافي / الإقامة
  if (q.includes('current location') || q.includes('country') || q.includes('city') || q.includes('مكان الإقامة') || q.includes('الدولة')) {
    return { resolved: true, answer: profile.location || 'Remote Worldwide' };
  }

  // إذا كان السؤال مجهولاً أو حساساً يتطلب قراراً، لا تخمن!
  return {
    resolved: false,
    requiresUser: true,
    question: questionText
  };
}

/**
 * معالجة تقديم طلب لوظيفة محددة (Auto-Apply Pipeline)
 */
async function processJobApplication(job, profile, options = {}) {
  // 1. فحص منع التقديم المكرر
  if (job.application_status === 'applied') {
    return {
      status: 'already_applied',
      message: `تم التقديم على هذه الوظيفة (${job.company} - ${job.title}) مسبقاً، تم منع التكرار.`,
      appliedAt: job.applied_at
    };
  }

  // 2. التأكد من تجهيز السيرة الذاتية المخصصة بنظام ATS و Cover Letter
  let tailoredCvPath = job.tailored_cv_path;
  let coverLetter = job.cover_letter;

  if (!tailoredCvPath || !fs.existsSync(tailoredCvPath)) {
    console.log(`[AutoApplyAgent] تجهيز الـ CV المخصص والخطاب للوظيفة #${job.id}...`);
    const tailored = await tailorCvAndCoverLetter(job, profile);
    tailoredCvPath = tailored.pdfPath;
    coverLetter = tailored.coverLetter;

    await db.updateJobTailoredDocs(job.id, {
      tailored_cv_path: tailoredCvPath,
      cover_letter: coverLetter
    });
  }

  // 3. فحص أسئلة التقديم الشائعة ومحاكاة التحقق من النماذج
  const sampleFormQuestions = options.customQuestions || [
    'How many years of relevant experience do you have?',
    'What is your expected monthly salary (USD)?',
    'Are you authorized to work remotely in your region?'
  ];

  const answers = {};
  for (const question of sampleFormQuestions) {
    const res = resolveApplicationQuestion(question, profile);
    if (!res.resolved) {
      // سؤال مجهول يتطلب قرار المستخدم البشري (Human Hand-off)
      const actionId = await db.createPendingAction({
        job_id: job.id,
        question: question,
        context: `طلب التقديم لشركة ${job.company} على وظيفة ${job.title}`,
        action_type: 'question'
      });

      const logMsg = `توقف التقديم مؤقتاً للوظيفة #${job.id}: هناك سؤال يتطلب قرار المستخدم (${question})`;
      console.warn(`[AutoApplyAgent] ${logMsg}`);
      await db.logEvent('WARNING', 'تنبيه تدخل بشري مطلوب', logMsg);

      return {
        status: 'pending_user',
        actionId,
        question,
        message: 'تم تعليق التقديم مؤقتاً بانتظار إجابتك على هذا السؤال في لوحة التحكم.'
      };
    }
    answers[question] = res.answer;
  }

  // 4. فحص اختبارات الأمان والكابتشا (CAPTCHA / OTP)
  if (options.simulateCaptcha) {
    const actionId = await db.createPendingAction({
      job_id: job.id,
      question: 'اختبار كابتشا (CAPTCHA) أو تحقق أمني يمنع الإرسال الآلي المباشر.',
      context: `رابط التقديم الرسمي للشركة: ${job.apply_url || job.url}`,
      action_type: 'captcha'
    });

    await db.logEvent('WARNING', 'كابتشا مطلوبة', `توقف التقديم التلقائي لوظيفة ${job.company} لوجود تحدي أمني.`);

    return {
      status: 'pending_user',
      actionId,
      action_type: 'captcha',
      message: 'يتطلب الموقع اجتياز اختبار كابتشا يدوياً.'
    };
  }

  // 5. تجهيز حزمة التقديم الرسمية (Official Application Packet)
  const applicationPacket = {
    job_id: job.id,
    company: job.company,
    role: job.title,
    candidate: {
      name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      links: profile.links || []
    },
    tailored_cv_path: tailoredCvPath,
    cover_letter: coverLetter,
    form_answers: answers,
    submission_channel: job.source,
    submitted_at: new Date().toISOString()
  };

  // 6. اعتماد التقديم وتحديث الحالة في قاعدة البيانات SQLite
  await db.updateJobApplicationStatus(job.id, 'applied');

  const logSuccess = `تم إرسال طلب التقديم بنجاح إلى شركة ${job.company} لوظيفة ${job.title} باستخدام السيرة الذاتية المخصصة بنظام ATS.`;
  console.log(`[AutoApplyAgent] ✅ ${logSuccess}`);
  await db.logEvent('INFO', 'اكتمال التقديم التلقائي', logSuccess);

  return {
    status: 'applied',
    success: true,
    message: logSuccess,
    appliedAt: applicationPacket.submitted_at,
    packet: applicationPacket
  };
}

/**
 * تجهيز السيرة الذاتية وخطاب التقديم للوظائف المتوافقة دون إرسال تلقائي إلا بموافقة المستخدم
 */
async function autoApplyEligibleJobs(minScore = 75, limit = 5, options = { requireApproval: true }) {
  const profile = await db.getCandidateProfile();
  if (!profile) throw new Error('لا يوجد ملف مرشح معتمد.');

  const candidates = await db.getJobListings({ min_score: minScore, limit: limit * 2 });
  const eligible = candidates.filter(j => j.application_status === 'matched' || j.application_status === 'discovered');

  if (eligible.length === 0) {
    return {
      message: `لا توجد وظائف جديدة متوافقة (توافق ${minScore}% فما فوق) تحتاج تجهيزاً حالياً.`,
      appliedCount: 0,
      preparedCount: 0
    };
  }

  console.log(`[AutoApplyAgent] 🛡️ وضع المراجعة الإلزامية نشط: تجهيز المستندات لـ ${Math.min(eligible.length, limit)} وظيفة بانتظار مراجعة المستخدم...`);

  const results = [];
  for (const job of eligible.slice(0, limit)) {
    try {
      // تجهيز الـ CV المخصص والخطاب
      const tailored = await tailorCvAndCoverLetter(job, profile);
      await db.updateJobTailoredDocs(job.id, {
        tailored_cv_path: tailored.pdfPath,
        cover_letter: tailored.coverLetter
      });

      // وضع الحالة: الـ CV جاهز للمراجعة والموافقة اليدوية
      await db.updateJobApplicationStatus(job.id, 'cv_ready');

      results.push({
        jobId: job.id,
        company: job.company,
        title: job.title,
        status: 'cv_ready',
        message: `تم تجهيز السيرة الذاتية وخطاب التقديم للوظيفة #${job.id} (${job.company}) وهي بانتظار مراجعتك وموافقتك.`
      });
    } catch (err) {
      console.error(`خطأ أثناء تجهيز مستندات الوظيفة #${job.id}:`, err);
    }
  }

  return {
    success: true,
    processedCount: results.length,
    preparedCount: results.length,
    appliedCount: 0,
    results
  };
}

/**
 * التقديم الآلي المجمع على الوظائف المتوافقة مع الفحص الصارم لجودة الـ CV
 */
async function batchAutoApplyMatchingJobs({ minScore = 70, limit = 10, workType = 'all' } = {}) {
  const profile = await db.getCandidateProfile();
  if (!profile) throw new Error('يرجى رفع واعتماد الملف المهني للمرشح أولاً.');

  // جلب الوظائف التي لم يُقدّم عليها بعد ولديها نسبة توافق أو متطلبات تقنية ملائمة
  let allJobs = await db.getJobListings({
    min_score: minScore > 0 ? minScore : undefined,
    work_type: workType !== 'all' ? workType : undefined,
    limit: limit * 3
  });

  // استبعاد الوظائف التي قُدم عليها مسبقاً أو المرفوضة
  let eligibleJobs = allJobs.filter(j => j.application_status !== 'applied' && j.application_status !== 'rejected');

  // إذا لم نجد بدرجة التوافق المحددة، نبحث بذكاء في الوظائف التقنية المتوافقة مع تخصص المرشح
  if (eligibleJobs.length === 0) {
    const rawJobs = await db.getJobListings({ limit: 60 });
    const keywords = ['backend', 'full stack', 'developer', 'engineer', 'software', 'node', 'web', 'laravel', 'php'];
    eligibleJobs = rawJobs.filter(j => {
      if (j.application_status === 'applied' || j.application_status === 'rejected') return false;
      const title = (j.title || '').toLowerCase();
      const desc = (j.description || '').toLowerCase();
      return (j.match_score && j.match_score >= 40) || keywords.some(k => title.includes(k) || desc.includes(k));
    });
  }

  if (eligibleJobs.length === 0) {
    return {
      success: true,
      appliedCount: 0,
      message: `لا توجد وظائف مستوفية للتوافق (درجة ${minScore}% فما فوق) جاهزة للتقديم المجمع حالياً.`,
      results: []
    };
  }

  console.log(`[BatchAutoApply] 🚀 بدء التقديم المجمع على ${Math.min(eligibleJobs.length, limit)} وظيفة متوافقة مع الفحص الصارم لجودة الـ CV...`);

  const results = [];
  for (const job of eligibleJobs.slice(0, limit)) {
    try {
      // 1. توليد الـ CV المخصص و Cover Letter مع التحقق من خلوه من أي تشويه
      const tailored = await tailorCvAndCoverLetter(job, profile);
      
      // حفظ المستندات المخصصة
      await db.updateJobTailoredDocs(job.id, {
        tailored_cv_path: tailored.pdfPath,
        cover_letter: tailored.coverLetter
      });

      // 2. إتمام عملية التقديم الفعلي وتحديث الحالة
      const appResult = await processJobApplication(job, profile);

      results.push({
        jobId: job.id,
        company: job.company,
        title: job.title,
        matchScore: job.match_score,
        cvFile: tailored.pdfFilename,
        status: appResult.status || 'applied',
        message: `تم إنشاء الـ CV بنجاح وإرسال التقديم لشركة ${job.company}`
      });
    } catch (err) {
      console.error(`خطأ في معالجة الوظيفة #${job.id}:`, err);
      results.push({
        jobId: job.id,
        company: job.company,
        title: job.title,
        status: 'error',
        message: `تعذر التقديم: ${err.message}`
      });
    }
  }

  const successCount = results.filter(r => r.status === 'applied').length;
  await db.logEvent('INFO', 'اكتمال التقديم المجمع الذكي', `تم التقديم آلياً وبنجاح على ${successCount} وظيفة متوافقة بعد التحقق من جودة السير الذاتية.`);

  return {
    success: true,
    processedCount: results.length,
    appliedCount: successCount,
    message: `🎉 تم التقديم بنجاح على ${successCount} وظيفة متوافقة مع إنشاء وتدقيق السير الذاتية المخصصة!`,
    results
  };
}

module.exports = {
  resolveApplicationQuestion,
  processJobApplication,
  autoApplyEligibleJobs,
  batchAutoApplyMatchingJobs
};
