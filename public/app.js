// State Management
let currentTab = 'jobs';
let currentJobData = null;
let currentJobModalLang = 'ar';
let activeClLang = 'en';
let currentMarkAppJobId = null;
let searchDebounce = null;
let jobSourcesList = [];

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  await Promise.allSettled([
    loadStats(),
    loadCandidateProfile(),
    loadJobSources(),
    loadJobsList(),
    loadManualApplicationsList(),
    loadEmails()
  ]);

  // Periodic stats refresh
  setInterval(() => {
    loadStats();
  }, 30000);
}

// ---------------- Navigation & Tab Switching ---------------- //
function switchTab(tabId) {
  currentTab = tabId;

  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

  const btnMap = {
    jobs: 'tabJobsBtn',
    sources: 'tabSourcesBtn',
    applied: 'tabAppliedBtn',
    profile: 'tabProfileBtn',
    inbox: 'tabInboxBtn',
    history: 'tabHistoryBtn',
    logs: 'tabLogsBtn'
  };

  const viewMap = {
    jobs: 'jobsView',
    sources: 'sourcesView',
    applied: 'appliedView',
    profile: 'profileView',
    inbox: 'inboxView',
    history: 'historyView',
    logs: 'logsView'
  };

  if (btnMap[tabId] && document.getElementById(btnMap[tabId])) {
    document.getElementById(btnMap[tabId]).classList.add('active');
  }

  if (viewMap[tabId] && document.getElementById(viewMap[tabId])) {
    document.getElementById(viewMap[tabId]).classList.add('active');
  }

  if (tabId === 'jobs') loadJobsList();
  else if (tabId === 'sources') loadJobSources();
  else if (tabId === 'applied') loadManualApplicationsList();
  else if (tabId === 'profile') loadCandidateProfile();
  else if (tabId === 'inbox') loadEmails();
  else if (tabId === 'history') loadHistory();
  else if (tabId === 'logs') loadLogs();
}

// ---------------- Load Global & Job Stats ---------------- //
async function loadStats() {
  try {
    const res = await fetch('/api/jobs/stats');
    const data = await res.json();
    if (data.success && data.stats) {
      const s = data.stats;
      document.getElementById('statNewJobs').innerText = s.newJobs || 0;
      document.getElementById('statMatchingJobs').innerText = s.matchingJobs || 0;
      document.getElementById('statHighMatchJobs').innerText = s.highMatchJobs || 0;
      document.getElementById('statCvsPrepared').innerText = s.cvsPrepared || 0;
      document.getElementById('statCoverLetters').innerText = s.coverLettersPrepared || 0;
      document.getElementById('statReadyToApply').innerText = s.readyToApply || 0;
      document.getElementById('statManuallyApplied').innerText = s.manuallyApplied || 0;
      document.getElementById('statExpiredJobs').innerText = s.expiredJobs || 0;
    }
  } catch (err) {
    console.warn('Error loading job stats:', err);
  }
}

// ---------------- 1. Jobs Matching My CV (استكشاف الوظائف) ---------------- //
async function loadJobsList() {
  const tbody = document.getElementById('jobsTableBody');
  if (!tbody) return;

  const search = document.getElementById('jobSearchInput')?.value.trim() || '';
  const status = document.getElementById('jobStatusFilter')?.value || 'all';
  const minScore = document.getElementById('jobScoreFilter')?.value;
  const workType = document.getElementById('jobWorkTypeFilter')?.value || 'all';
  const source = document.getElementById('jobSourceFilter')?.value || 'all';
  const sortBy = document.getElementById('jobSortBy')?.value || 'match_score';

  tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 2rem;">جاري تحميل ومطابقة الوظائف... ⏳</td></tr>';

  try {
    const params = new URLSearchParams({
      search,
      status,
      work_type: workType,
      source,
      sort_by: sortBy,
      limit: '100'
    });
    if (minScore !== undefined && minScore !== '') {
      params.append('min_score', minScore);
    }
    if (status === 'EXPIRED') params.append('include_expired', 'true');

    const res = await fetch(`/api/jobs?${params.toString()}`);
    const data = await res.json();

    if (!data.success || !data.jobs || data.jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 2.5rem; color: var(--text-muted);">لا توجد وظائف مطابقة لمعايير البحث الحالية (درجة التوافق 50%+). يمكنك اختيار "عرض كل الوظائف" من الفلتر أو الضغط على "مطابقة وتقييم الوظائف".</td></tr>';
      return;
    }

    tbody.innerHTML = data.jobs.map(job => renderJobTableRow(job)).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color:#ef4444; padding:2rem;">حدث خطأ أثناء تحميل الوظائف: ${err.message}</td></tr>`;
  }
}

function renderJobTableRow(job) {
  const score = job.match_score || 0;
  let scoreHtml = '';
  
  if (score >= 80) {
    scoreHtml = `<span class="score-badge score-high">🚀 ${score}%</span>`;
  } else if (score >= 60) {
    scoreHtml = `<span class="score-badge score-good">🎯 ${score}%</span>`;
  } else if (score >= 50) {
    scoreHtml = `<span class="score-badge score-mid">🔹 ${score}%</span>`;
  } else if (score > 0) {
    scoreHtml = `<span class="score-badge score-low">${score}%</span>`;
  } else if (!job.ai_summary_ar) {
    scoreHtml = `<span class="score-badge score-pending" title="لم يتم تقييمها بعد بالذكاء الاصطناعي">⏳ قيد التقييم</span>`;
  } else {
    scoreHtml = `<span class="score-badge score-zero" title="الوظيفة خارج التخصص أو لا تطابق السيرة الذاتية">❌ غير متوافقة</span>`;
  }

  const status = (job.application_status || 'NEW').toUpperCase();
  const statusTextMap = {
    'NEW': 'جديدة',
    'MATCHED': 'متطابقة 🎯',
    'CV_READY': 'الـ CV جاهز 📄',
    'READY_TO_APPLY': 'جاهزة للتقديم ⚡',
    'APPLIED_MANUALLY': 'تم التقديم ✅',
    'REJECTED': 'مستبعدة ❌',
    'EXPIRED': 'منتهية ⌛'
  };
  const statusDisplay = statusTextMap[status] || status;

  // Work type badge
  const wtClass = job.work_type === 'remote' ? 'badge-info' : (job.work_type === 'hybrid' ? 'badge-important' : 'badge-normal');
  const wtText = job.work_type === 'remote' ? '🌐 عن بعد' : (job.work_type === 'hybrid' ? '🔄 هجين' : '🏢 حضوري');

  const displayTitle = job.title_ar ? `${job.title_ar}` : job.title;
  const subTitle = job.title_ar && job.title !== job.title_ar ? job.title : '';

  return `
    <tr id="jobRow_${job.id}">
      <!-- 1. الوظيفة والشركة -->
      <td>
        <div class="job-cell-main">
          <div class="job-cell-title" onclick="openJobModal(${job.id})" title="اضغط لعرض التفاصيل الكاملة">${escapeHtml(displayTitle)}</div>
          ${subTitle ? `<div class="job-cell-subtitle">${escapeHtml(subTitle)}</div>` : ''}
          <div class="job-cell-meta">
            <span class="company-tag">🏢 ${escapeHtml(job.company)}</span>
            <span class="location-tag">📍 ${escapeHtml(job.location || 'Worldwide')}</span>
          </div>
        </div>
      </td>

      <!-- 2. العمل والراتب -->
      <td>
        <div class="job-cell-work">
          <span class="badge ${wtClass}">${wtText}</span>
          <span class="salary-text">${escapeHtml(job.salary_raw || 'غير معلن')}</span>
        </div>
      </td>

      <!-- 3. نسبة التوافق -->
      <td style="text-align: center;">
        ${scoreHtml}
      </td>

      <!-- 4. المصدر والحالة -->
      <td>
        <div class="job-cell-source-status">
          <span class="source-badge">${escapeHtml(job.source)}</span>
          <span class="badge status-badge-${status}">${statusDisplay}</span>
        </div>
      </td>

      <!-- 5. الإجراءات -->
      <td>
        <div class="job-cell-actions">
          <button class="btn btn-outline-primary btn-sm" onclick="openJobModal(${job.id})" title="عرض التفاصيل والترجمة الكاملة">
            <span>👁️ التفاصيل</span>
          </button>
          <a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" title="فتح موقع الإعلان للتقديم">
            <span>🌐 التقديم ↗</span>
          </a>
          <button class="btn btn-purple btn-sm" onclick="quickPrepareCv(${job.id})" title="تجهيز CV وخطاب تقديم مخصص">
            <span>✨ CV مخصص</span>
          </button>
          <button class="btn btn-success btn-sm" onclick="openMarkAppliedModal(${job.id})" title="توثيق التقديم يدوياً">
            <span>✅ تأكيد التقديم</span>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function handleJobSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    loadJobsList();
  }, 350);
}

// ---------------- 2. Full Job Details Modal & Arabic Translation ---------------- //
async function openJobModal(jobId) {
  try {
    const modal = document.getElementById('jobModal');
    modal.classList.add('active');

    document.getElementById('modalJobTitle').innerText = 'جاري تحميل تفاصيل الوظيفة...';
    document.getElementById('modalJobCompany').innerText = '...';
    document.getElementById('modalJobAiSummary').innerText = 'جاري توليد وتحميل ملخص الذكاء الاصطناعي...';
    document.getElementById('modalJobDescription').innerText = 'جاري التحميل...';

    const res = await fetch(`/api/jobs/${jobId}`);
    const data = await res.json();

    if (!data.success || !data.job) {
      alert('تعذر جلب تفاصيل الوظيفة.');
      closeJobModal();
      return;
    }

    currentJobData = data.job;
    currentJobModalLang = 'ar';
    activeClLang = 'en';

    renderJobModalContent(currentJobData, currentJobModalLang);
  } catch (err) {
    alert('حدث خطأ أثناء تحميل بيانات الوظيفة: ' + err.message);
    closeJobModal();
  }
}

function switchJobModalLang(lang) {
  currentJobModalLang = lang;
  document.getElementById('btnLangAr').classList.toggle('active', lang === 'ar');
  document.getElementById('btnLangEn').classList.toggle('active', lang === 'en');

  if (currentJobData) {
    renderJobModalContent(currentJobData, lang);
  }
}

function renderJobModalContent(job, lang = 'ar') {
  const isAr = lang === 'ar';

  // Header & Badges
  document.getElementById('modalJobSourceBadge').innerText = `المصدر: ${job.source}`;
  document.getElementById('modalJobWorkTypeBadge').innerText = job.work_type === 'remote' ? '🌐 عن بعد (Remote)' : (job.work_type === 'hybrid' ? '🔄 هجين' : '🏢 حضوري');
  document.getElementById('modalJobStatusBadge').innerText = `الحالة: ${job.application_status}`;
  document.getElementById('modalJobStatusBadge').className = `badge status-badge-${(job.application_status || 'NEW').toUpperCase()}`;

  document.getElementById('modalJobTitle').innerText = isAr ? (job.title_ar || job.title) : job.title;
  document.getElementById('modalJobCompany').innerText = job.company;
  document.getElementById('modalJobLocation').innerText = job.location || 'Remote Worldwide';
  document.getElementById('modalJobSalary').innerText = job.salary_raw || 'غير معلن (قابل للتفاوض)';

  // AI Summary
  document.getElementById('modalJobAiSummary').innerText = job.ai_summary_ar || `تبحث شركة ${job.company} عن ${job.title}. يتضمن الدور تطوير وصيانة الأنظمة البرمجية بنمط عمل (${job.work_type || 'عن بعد'}).`;

  // Match Score
  const score = job.match_score || 0;
  document.getElementById('modalJobMatchScoreNum').innerText = `${score}%`;
  document.getElementById('modalJobMatchHeadline').innerText = isAr ? `تحليل التوافق المهني (${score}%)` : `Professional Match Analysis (${score}%)`;
  document.getElementById('modalJobMatchSummary').innerText = job.match_reasons || 'توافق في المهارات التقنية والبرمجية.';

  // Requirements: Mandatory vs Preferred
  const reqMandatory = job.req_mandatory && job.req_mandatory.length > 0 ? job.req_mandatory : (job.matched_skills || ['تطوير الواجهات الخلفية']);
  const reqPreferred = job.req_preferred && job.req_preferred.length > 0 ? job.req_preferred : (job.missing_skills || ['غير محدد']);

  document.getElementById('modalJobReqMandatory').innerHTML = reqMandatory.map(r => `<li>${escapeHtml(r)}</li>`).join('');
  document.getElementById('modalJobReqPreferred').innerHTML = reqPreferred.map(r => `<li>${escapeHtml(r)}</li>`).join('');

  // Matched Skills vs Missing Skills
  const matchedSkills = job.matched_skills && job.matched_skills.length > 0 ? job.matched_skills : ['تطوير البرمجيات'];
  const missingSkills = job.missing_skills && job.missing_skills.length > 0 ? job.missing_skills : ['لا توجد نواقص جوهرية'];

  document.getElementById('modalJobMatchedSkills').innerHTML = matchedSkills.map(s => `<span class="badge badge-urgent" style="font-size:0.85rem;">✅ ${escapeHtml(s)}</span>`).join('');
  document.getElementById('modalJobMissingSkills').innerHTML = missingSkills.map(s => `<span class="badge badge-normal" style="font-size:0.85rem;">⚠️ ${escapeHtml(s)}</span>`).join('');

  // Strengths & Weaknesses
  const strengths = job.match_strengths && job.match_strengths.length > 0 ? job.match_strengths : matchedSkills.map(s => `خبرة عملية في تطبيق ${s}`);
  const weaknesses = job.match_weaknesses && job.match_weaknesses.length > 0 ? job.match_weaknesses : ['لا توجد نقاط ضعف بارزة تؤثر على الأهلية'];

  document.getElementById('modalJobStrengths').innerHTML = strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  document.getElementById('modalJobWeaknesses').innerHTML = weaknesses.map(w => `<li>${escapeHtml(w)}</li>`).join('');

  // Overview Items
  document.getElementById('ovWorkType').innerText = job.work_type === 'remote' ? 'عن بعد (Remote)' : (job.work_type === 'hybrid' ? 'هجين (Hybrid)' : 'حضوري (On-site)');
  document.getElementById('ovEmpType').innerText = job.employment_type || 'دوام كامل (Full-time)';
  document.getElementById('ovPublishedAt').innerText = job.published_at ? formatDateClean(job.published_at) : 'غير محدد';
  document.getElementById('ovDeadline').innerText = job.expires_at ? formatDateClean(job.expires_at) : 'غير محدد';
  document.getElementById('ovExperience').innerText = job.req_experience || 'غير محدد';
  document.getElementById('ovEducation').innerText = job.req_education || 'غير محدد';

  // Responsibilities
  const respList = (isAr && job.responsibilities_ar && job.responsibilities_ar.length > 0)
    ? job.responsibilities_ar
    : (job.responsibilities_en && job.responsibilities_en.length > 0 ? job.responsibilities_en : ['تطوير وبناء الأنظمة والواجهات الخلفية', 'كتابة واجهات برمجة تطبيقات (REST APIs)', 'تحسين كفاءة قواعد البيانات']);
  document.getElementById('modalJobResponsibilities').innerHTML = respList.map(r => `<li>${escapeHtml(r)}</li>`).join('');

  // Benefits
  const benefitsList = job.benefits && job.benefits.length > 0 ? job.benefits : ['العمل عن بعد (Remote)', 'ساعات عمل مرنة', 'راتب مجزٍ حسب الخبرة'];
  document.getElementById('modalJobBenefits').innerHTML = benefitsList.map(b => `<li>${escapeHtml(b)}</li>`).join('');

  // Description
  document.getElementById('jobDescCardTitle').innerText = isAr ? '📄 الوصف الوظيفي الكامل (مترجم للعربية)' : '📄 Full Original Job Description';
  document.getElementById('modalJobDescription').innerText = isAr ? (job.description_ar || job.description || 'لا يوجد وصف مفصل') : (job.description || 'No description available');

  // Direct Apply Link (Canonical URL)
  const applyLink = document.getElementById('modalJobApplyLink');
  applyLink.href = job.url;

  // Tailored Documents Status
  const hasCv = !!job.tailored_cv_path;
  const hasCl = !!(job.cover_letter_en || job.cover_letter || job.cover_letter_ar);
  const docsBox = document.getElementById('tailoredDocsResultBox');

  if (hasCv || hasCl) {
    docsBox.style.display = 'block';
    document.getElementById('downloadTailoredCvLink').href = `/api/jobs/${job.id}/cv`;
    document.getElementById('downloadCoverLetterPdfLink').href = `/api/jobs/${job.id}/cover-letter-pdf`;

    const clText = activeClLang === 'ar' ? (job.cover_letter_ar || '') : (job.cover_letter_en || job.cover_letter || '');
    document.getElementById('modalJobCoverLetterText').value = clText;
  } else {
    docsBox.style.display = 'none';
  }

  // Applied Banner
  const appliedBanner = document.getElementById('modalAppliedStatusBanner');
  if (job.application_status === 'APPLIED_MANUALLY' || job.applied_at) {
    appliedBanner.style.display = 'block';
    document.getElementById('modalAppliedDateText').innerText = `تاريخ التقديم: ${formatDateClean(job.applied_at || job.updated_at)}`;
  } else {
    appliedBanner.style.display = 'none';
  }
}

function switchClTab(lang) {
  activeClLang = lang;
  document.getElementById('btnClTabEn').classList.toggle('active', lang === 'en');
  document.getElementById('btnClTabAr').classList.toggle('active', lang === 'ar');

  if (currentJobData) {
    const clText = lang === 'ar' ? (currentJobData.cover_letter_ar || '') : (currentJobData.cover_letter_en || currentJobData.cover_letter || '');
    document.getElementById('modalJobCoverLetterText').value = clText;
  }
}

async function copyActiveCoverLetter() {
  const text = document.getElementById('modalJobCoverLetterText').value;
  if (!text) {
    alert('لا يوجد نص خطاب تقديم للنسخ.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    alert('تم نسخ خطاب التقديم إلى الحافظة بنجاح! 📋');
  } catch {
    alert('يرجى تحديد النص ونسخه يدوياً.');
  }
}

async function saveEditedCoverLetter() {
  if (!currentJobData) return;
  const text = document.getElementById('modalJobCoverLetterText').value;
  const payload = activeClLang === 'ar' ? { cover_letter_ar: text } : { cover_letter_en: text, cover_letter: text };

  try {
    const res = await fetch(`/api/jobs/${currentJobData.id}/cover-letter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      currentJobData = data.job;
      alert('تم حفظ تعديلات خطاب التقديم بنجاح! 💾');
    }
  } catch (err) {
    alert('فشل حفظ التعديل: ' + err.message);
  }
}

// ---------------- 3. Generate Tailored CV & Cover Letter ---------------- //
async function generateTailoredDocsForCurrentJob() {
  if (!currentJobData) return;
  const btn = document.getElementById('btnGenerateTailoredCv');
  const spinner = document.getElementById('tailorSpinner');
  const btnText = document.getElementById('tailorBtnText');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.innerText = 'جاري تخصيص الـ CV و Cover Letter...';

  try {
    const res = await fetch(`/api/jobs/${currentJobData.id}/prepare-cv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (data.success && data.job) {
      currentJobData = data.job;
      renderJobModalContent(currentJobData, currentJobModalLang);
      loadStats();
      loadJobsList();
      alert('تم إنشاء وتجهيز السيرة الذاتية المخصصة وخطاب التقديم (بالعربية والإنجليزية) بنجاح! 🎉');
    } else {
      alert('حدث خطأ: ' + (data.error || 'تعذر التجهيز'));
    }
  } catch (err) {
    alert('خطأ أثناء تجهيز المستندات: ' + err.message);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.innerText = '✨ تجهيز الـ CV و Cover Letter الآن';
  }
}

async function quickPrepareCv(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}/prepare-cv`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      loadStats();
      loadJobsList();
      alert('تم تجهيز السيرة الذاتية المخصصة وخطاب التقديم بنجاح! 📄');
    } else {
      alert('خطأ: ' + (data.error || 'فشل التجهيز'));
    }
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

async function reMatchCurrentJob() {
  if (!currentJobData) return;
  const btn = document.getElementById('btnReMatchJob');
  btn.disabled = true;
  btn.innerText = 'جاري التقييم...';

  try {
    const res = await fetch(`/api/jobs/${currentJobData.id}/match`, { method: 'POST' });
    const data = await res.json();
    if (data.success && data.job) {
      currentJobData = data.job;
      renderJobModalContent(currentJobData, currentJobModalLang);
      loadStats();
      loadJobsList();
    }
  } catch (err) {
    alert('خطأ في إعادة التقييم: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'إعادة التقييم ⚡';
  }
}

function closeJobModal() {
  document.getElementById('jobModal').classList.remove('active');
  currentJobData = null;
}

function closeJobModalOnOverlay(e) {
  if (e.target === document.getElementById('jobModal')) {
    closeJobModal();
  }
}

// ---------------- 4. Manual Application Confirmation Modal ---------------- //
function openMarkAppliedModalForCurrentJob() {
  if (!currentJobData) return;
  openMarkAppliedModal(currentJobData.id);
}

function openMarkAppliedModal(jobId) {
  currentMarkAppJobId = jobId;
  const modal = document.getElementById('markAppliedModal');

  fetch(`/api/jobs/${jobId}`).then(r => r.json()).then(data => {
    if (data.success && data.job) {
      const j = data.job;
      document.getElementById('markAppCompany').innerText = j.company;
      document.getElementById('markAppTitle').innerText = j.title_ar ? `${j.title_ar} (${j.title})` : j.title;
      const urlElem = document.getElementById('markAppUrl');
      urlElem.innerText = j.url;
      urlElem.href = j.url;
      document.getElementById('markAppNotes').value = '';
      modal.classList.add('active');
    }
  });
}

function closeMarkAppliedModal() {
  document.getElementById('markAppliedModal').classList.remove('active');
  currentMarkAppJobId = null;
}

function closeMarkAppliedModalOnOverlay(e) {
  if (e.target === document.getElementById('markAppliedModal')) {
    closeMarkAppliedModal();
  }
}

async function confirmMarkAppliedSubmit() {
  if (!currentMarkAppJobId) return;
  const btn = document.getElementById('btnConfirmMarkApplied');
  const notes = document.getElementById('markAppNotes').value.trim();

  btn.disabled = true;
  btn.innerText = 'جاري التوثيق...';

  try {
    const res = await fetch(`/api/jobs/${currentMarkAppJobId}/mark-applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    const data = await res.json();

    if (data.success) {
      closeMarkAppliedModal();
      if (currentJobData && currentJobData.id === currentMarkAppJobId) {
        currentJobData = data.job;
        renderJobModalContent(currentJobData, currentJobModalLang);
      }
      loadStats();
      loadJobsList();
      loadManualApplicationsList();
      alert('تم توثيق تقديمك اليدوي بنجاح! 🎯 مبارك وفي انتظار ردود المقابلات.');
    } else {
      alert('خطأ: ' + (data.error || 'فشل التوثيق'));
    }
  } catch (err) {
    alert('خطأ: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'تأكيد وتسجيل التقديم اليدوي رسمياً 🎯';
  }
}

async function setJobStatus(status) {
  if (!currentJobData) return;
  try {
    const res = await fetch(`/api/jobs/${currentJobData.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await res.json();
    if (data.success && data.job) {
      currentJobData = data.job;
      renderJobModalContent(currentJobData, currentJobModalLang);
      loadStats();
      loadJobsList();
    }
  } catch (err) {
    alert('خطأ في تحديث الحالة: ' + err.message);
  }
}

// ---------------- 5. Job Sources Management ---------------- //
async function loadJobSources() {
  const tbody = document.getElementById('sourcesTableBody');
  const select = document.getElementById('jobSourceFilter');

  try {
    const res = await fetch('/api/job-sources');
    const data = await res.json();

    if (data.success && Array.isArray(data.sources)) {
      jobSourcesList = data.sources;

      // Render table
      if (tbody) {
        tbody.innerHTML = data.sources.map(s => `
          <tr>
            <td><strong style="color:#fff; font-size:0.95rem;">${escapeHtml(s.name)}</strong></td>
            <td><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; font-size:0.85rem;">${escapeHtml(s.url)} ↗</a></td>
            <td><span class="badge ${s.type === 'api' ? 'badge-info' : 'badge-important'}">${s.type.toUpperCase()}</span></td>
            <td><span style="font-size:0.8rem; color:var(--text-muted); font-family:monospace;">${escapeHtml(s.api_endpoint || 'غير متاح')}</span></td>
            <td>
              <label class="switch-toggle" title="${s.is_active ? 'المصدر مفعل' : 'المصدر معطل'}">
                <input type="checkbox" ${s.is_active ? 'checked' : ''} onchange="toggleSourceStatus(${s.id})">
                <span class="switch-slider"></span>
              </label>
              <span style="font-size:0.8rem; color:${s.is_active ? '#34d399' : '#f87171'}; margin-right:0.4rem; font-weight:700;">
                ${s.is_active ? 'مفعل' : 'معطل'}
              </span>
            </td>
            <td><span style="font-size:0.82rem; color:var(--text-muted);">${s.last_fetch_at ? formatDateClean(s.last_fetch_at) : 'لم يتم الجلب بعد'}</span></td>
            <td><strong style="color:#38bdf8;">${s.total_fetched || 0}</strong></td>
            <td><strong style="color:#34d399;">${s.valid_jobs || 0}</strong></td>
            <td><strong style="color:#fbbf24;">${s.duplicates_count || 0}</strong></td>
            <td>
              <div style="display:flex; gap:0.35rem;">
                <button class="btn btn-secondary btn-sm" onclick="openEditSourceModal(${s.id})">✏️ تعديل</button>
                <button class="btn btn-secondary btn-sm" onclick="deleteSource(${s.id})" style="color:#f87171; border-color:rgba(239,68,68,0.3);">🗑️ حذف</button>
              </div>
            </td>
          </tr>
        `).join('');
      }

      // Populate filter dropdown
      if (select) {
        const currentVal = select.value;
        select.innerHTML = '<option value="all">كل المصادر (All Sources)</option>' +
          data.sources.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} ${s.is_active ? '✅' : '⏸️'}</option>`).join('');
        select.value = currentVal || 'all';
      }
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="color:#f87171;">خطأ في جلب مصادر الوظائف: ${err.message}</td></tr>`;
  }
}

function openAddSourceModal() {
  document.getElementById('sourceModalTitle').innerText = '➕ إضافة مصدر وظائف جديد';
  document.getElementById('sourceEditId').value = '';
  document.getElementById('sourceInputName').value = '';
  document.getElementById('sourceInputUrl').value = '';
  document.getElementById('sourceInputType').value = 'api';
  document.getElementById('sourceInputEndpoint').value = '';
  document.getElementById('sourceInputActive').checked = true;
  document.getElementById('sourceSubmitBtnText').innerText = 'إضافة المصدر';
  document.getElementById('sourceModal').classList.add('active');
}

function openEditSourceModal(id) {
  const src = jobSourcesList.find(s => s.id === id);
  if (!src) return;

  document.getElementById('sourceModalTitle').innerText = `✏️ تعديل مصدر: ${src.name}`;
  document.getElementById('sourceEditId').value = src.id;
  document.getElementById('sourceInputName').value = src.name;
  document.getElementById('sourceInputUrl').value = src.url;
  document.getElementById('sourceInputType').value = src.type;
  document.getElementById('sourceInputEndpoint').value = src.api_endpoint || '';
  document.getElementById('sourceInputActive').checked = !!src.is_active;
  document.getElementById('sourceSubmitBtnText').innerText = 'حفظ التعديلات';
  document.getElementById('sourceModal').classList.add('active');
}

function closeSourceModal() {
  document.getElementById('sourceModal').classList.remove('active');
}

function closeSourceModalOnOverlay(e) {
  if (e.target === document.getElementById('sourceModal')) closeSourceModal();
}

async function handleSourceSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('sourceEditId').value;
  const name = document.getElementById('sourceInputName').value.trim();
  const url = document.getElementById('sourceInputUrl').value.trim();
  const type = document.getElementById('sourceInputType').value;
  const api_endpoint = document.getElementById('sourceInputEndpoint').value.trim() || null;
  const is_active = document.getElementById('sourceInputActive').checked ? 1 : 0;

  try {
    const endpoint = id ? `/api/job-sources/${id}` : '/api/job-sources';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, type, api_endpoint, is_active })
    });
    const data = await res.json();

    if (data.success) {
      closeSourceModal();
      loadJobSources();
      alert(data.message || 'تم حفظ المصدر بنجاح.');
    } else {
      alert('خطأ: ' + (data.error || 'فشل الحفظ'));
    }
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

async function toggleSourceStatus(id) {
  try {
    const res = await fetch(`/api/job-sources/${id}/toggle`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      loadJobSources();
    }
  } catch (err) {
    alert('خطأ في تغيير حالة المصدر: ' + err.message);
  }
}

async function deleteSource(id) {
  if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المصدر نهائياً؟')) return;
  try {
    const res = await fetch(`/api/job-sources/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      loadJobSources();
    }
  } catch (err) {
    alert('خطأ في حذف المصدر: ' + err.message);
  }
}

// ---------------- 6. Manual Applications List ---------------- //
async function loadManualApplicationsList() {
  const tbody = document.getElementById('manualApplicationsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/manual-applications');
    const data = await res.json();

    if (!data.success || !data.applications || data.applications.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="padding: 2.5rem; color: var(--text-muted);">لم يتم توثيق أي تقديم يدوي حتى الآن. بعد التقديم على أي وظيفة، اضغط على "تأكيد التقديم يدوياً".</td></tr>';
      return;
    }

    tbody.innerHTML = data.applications.map(app => `
      <tr>
        <td><strong style="color:#fff; font-size:0.95rem;">${escapeHtml(app.company)}</strong></td>
        <td><strong style="color:#38bdf8;">${escapeHtml(app.title)}</strong></td>
        <td><span class="country-badge">📍 ${escapeHtml(app.location || 'Remote')} (${app.work_type || 'remote'})</span></td>
        <td><span style="color:#34d399; font-weight:700; font-size:0.88rem;">⏱️ ${formatDateClean(app.applied_at)}</span></td>
        <td><span style="color:#a5b4fc; font-size:0.82rem;">${escapeHtml(app.source || 'Direct')}</span></td>
        <td><span class="badge badge-urgent">${app.match_score || 0}%</span></td>
        <td>
          <div style="display:flex; gap:0.35rem;">
            ${app.tailored_cv_path ? `<a href="/api/jobs/${app.job_id}/cv" target="_blank" class="btn btn-secondary btn-sm" style="font-size:0.75rem;">📄 الـ CV</a>` : ''}
            <a href="/api/jobs/${app.job_id}/cover-letter-pdf" target="_blank" class="btn btn-secondary btn-sm" style="font-size:0.75rem;">✉️ الخطاب</a>
          </div>
        </td>
        <td><a href="${escapeHtml(app.job_url)}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; font-size:0.85rem;">رابط الإعلان ↗</a></td>
        <td><span style="font-size:0.82rem; color:var(--text-muted);">${escapeHtml(app.notes || 'تقديم يدوي مباشر')}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="color:#f87171;">خطأ في تحميل سجل التقديمات: ${err.message}</td></tr>`;
  }
}

// ---------------- 7. Global Actions (Fetch & Match) ---------------- //
async function triggerFetchJobsNow() {
  const btn = document.getElementById('btnFetchJobsTop');
  const icon = document.getElementById('fetchIcon');

  btn.disabled = true;
  if (icon) icon.classList.add('spinning');

  try {
    const res = await fetch('/api/jobs/fetch-now', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      loadStats();
      loadJobSources();
      loadJobsList();
      alert(`اكتمل جلب الوظائف من المصادر المفعلة!\nتم استلام ${data.totalReceived} وظيفة، وحفظ ${data.newlyInserted} وظيفة جديدة.`);
    } else {
      alert('تنبيه: ' + (data.message || data.error));
    }
  } catch (err) {
    alert('خطأ أثناء جلب الوظائف: ' + err.message);
  } finally {
    btn.disabled = false;
    if (icon) icon.classList.remove('spinning');
  }
}

async function triggerMatchAllJobs() {
  const btn = document.getElementById('btnMatchAllJobs');
  btn.disabled = true;
  btn.innerText = 'جاري التقييم والمطابقة بالذكاء الاصطناعي... ⏳';

  try {
    const res = await fetch('/api/jobs/match-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20 })
    });
    const data = await res.json();

    if (data.success) {
      loadStats();
      loadJobsList();
      alert(`اكتمل تقييم ومطابقة الوظائف!\nتم تحليل ومطابقة ${data.analyzedCount || 0} وظيفة بنجاح.`);
    }
  } catch (err) {
    alert('خطأ في المطابقة: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = '🎯 مطابقة وتقييم الوظائف الجديدة بالذكاء الاصطناعي';
  }
}

// ---------------- 8. Candidate Profile & CV Management ---------------- //
async function loadCandidateProfile() {
  try {
    const res = await fetch('/api/candidate/profile');
    const data = await res.json();

    if (data.success && data.profile) {
      const p = data.profile;
      document.getElementById('candidateProfileDisplay').style.display = 'block';

      document.getElementById('profFullName').innerText = p.full_name || 'اسم المرشح';
      document.getElementById('profHeadline').innerText = p.headline || 'المسمى الوظيفي';
      document.getElementById('profEmail').innerText = `✉️ ${p.email || ''}`;
      document.getElementById('profPhone').innerText = `📞 ${p.phone || ''}`;
      document.getElementById('profLocation').innerText = `📍 ${p.location || ''}`;
      document.getElementById('profExperience').innerText = `⏳ ${p.years_of_experience || 0} سنوات خبرة`;

      document.getElementById('profSummary').innerText = p.summary || 'لا يوجد ملخص';

      // Skills
      const skillsContainer = document.getElementById('profSkillsCategories');
      const allSkills = p.all_skills_flat || [];
      skillsContainer.innerHTML = allSkills.map(s => `<span class="badge badge-normal" style="font-size:0.85rem;">${escapeHtml(s)}</span>`).join('');

      // Experience
      const expContainer = document.getElementById('profExperienceList');
      if (Array.isArray(p.experience) && p.experience.length > 0) {
        expContainer.innerHTML = p.experience.map(e => `
          <div style="margin-bottom:0.75rem; border-right:3px solid var(--primary); padding-right:0.75rem;">
            <strong style="color:#fff;">${escapeHtml(e.title)}</strong> في <span style="color:#38bdf8;">${escapeHtml(e.company)}</span> (${escapeHtml(e.start_date || '')} - ${escapeHtml(e.end_date || 'Present')})
            <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.25rem;">${escapeHtml(e.description || '')}</p>
          </div>
        `).join('');
      } else {
        expContainer.innerHTML = '<p style="color:var(--text-muted);">لا توجد خبرات سابقة مضافة.</p>';
      }

      // Preferences form
      if (document.getElementById('prefMinSalary')) document.getElementById('prefMinSalary').value = p.min_salary || 2000;
      if (document.getElementById('prefLocation')) document.getElementById('prefLocation').value = p.preferred_locations || 'Remote Worldwide';
      if (document.getElementById('prefTargetRole')) document.getElementById('prefTargetRole').value = p.target_role || p.headline || '';

      if (p.original_cv_path) {
        document.getElementById('btnDownloadOriginalCv').style.display = 'inline-flex';
      }
    }
  } catch (err) {
    console.warn('Error loading candidate profile:', err);
  }
}

function handleFileSelected(input) {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    document.getElementById('dropZoneText').innerText = `الملف المختار: ${file.name}`;
    document.getElementById('btnUploadCv').disabled = false;
  }
}

async function handleCvUpload(e) {
  e.preventDefault();
  const fileInput = document.getElementById('cvFileInput');
  if (!fileInput.files || !fileInput.files[0]) return;

  const btn = document.getElementById('btnUploadCv');
  const btnText = document.getElementById('uploadBtnText');
  btn.disabled = true;
  btnText.innerText = 'جاري تحليل واستخراج الملف المهني... ⏳';

  const formData = new FormData();
  formData.append('cv', fileInput.files[0]);

  try {
    const res = await fetch('/api/candidate/upload-cv', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      loadCandidateProfile();
      alert('تم تحليل السيرة الذاتية واستخراج الملف المهني بنجاح! 🎉');
    } else {
      alert('خطأ: ' + (data.error || 'فشل التحليل'));
    }
  } catch (err) {
    alert('خطأ في الرفع: ' + err.message);
  } finally {
    btn.disabled = false;
    btnText.innerText = 'تحليل واستخراج الملف المهني';
  }
}

async function handleSavePreferences(e) {
  e.preventDefault();
  const min_salary = document.getElementById('prefMinSalary').value;
  const preferred_locations = document.getElementById('prefLocation').value;
  const target_role = document.getElementById('prefTargetRole').value;

  const work_types = [];
  if (document.getElementById('workTypeRemote').checked) work_types.push('remote');
  if (document.getElementById('workTypeOnsite').checked) work_types.push('on-site');
  if (document.getElementById('workTypeHybrid').checked) work_types.push('hybrid');

  try {
    const res = await fetch('/api/candidate/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_salary, preferred_locations, target_role, work_types, is_confirmed: 1 })
    });
    const data = await res.json();
    if (data.success) {
      alert('تم حفظ واعتماد تفضيلات التوظيف بنجاح! ✅');
      loadCandidateProfile();
    }
  } catch (err) {
    alert('خطأ في حفظ التفضيلات: ' + err.message);
  }
}

// ---------------- 9. Gmail Inbox & Details ---------------- //
async function loadEmails() {
  const tbody = document.getElementById('emailsTableBody');
  if (!tbody) return;

  try {
    const priority = document.getElementById('priorityFilter')?.value || 'all';
    const search = document.getElementById('searchInput')?.value.trim() || '';

    const params = new URLSearchParams({ priority, search, limit: '50' });
    const res = await fetch(`/api/emails?${params.toString()}`);
    const emails = await res.json();

    if (!Array.isArray(emails) || emails.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:2rem; color:var(--text-muted);">لا توجد رسائل مسجلة.</td></tr>';
      return;
    }

    tbody.innerHTML = emails.map(m => `
      <tr>
        <td><span class="badge ${m.priority === 'عاجل' ? 'badge-urgent' : (m.priority === 'مهم' ? 'badge-important' : 'badge-normal')}">${m.priority || 'عادي'}</span></td>
        <td><strong style="color:#fff;">${escapeHtml(m.company || 'غير محدد')}</strong></td>
        <td><strong style="color:#38bdf8;">${escapeHtml(m.subject || '(بدون عنوان)')}</strong></td>
        <td><span style="font-size:0.85rem; color:var(--text-muted);">${escapeHtml(m.summary || '')}</span></td>
        <td><span class="badge ${m.action_required ? 'badge-action-yes' : 'badge-action-no'}">${m.action_required ? '⚡ نعم' : 'لا'}</span></td>
        <td><span style="font-size:0.82rem; color:var(--text-muted);">${formatDateClean(m.date || m.processed_at)}</span></td>
        <td><button class="btn btn-secondary btn-sm" onclick="openEmailModal(${m.id})">عرض ↗</button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color:#f87171;">خطأ: ${err.message}</td></tr>`;
  }
}

async function openEmailModal(emailId) {
  try {
    const res = await fetch('/api/emails');
    const emails = await res.json();
    const email = emails.find(e => e.id === emailId);
    if (!email) return;

    document.getElementById('modalSubject').innerText = email.subject || '';
    document.getElementById('modalSender').innerText = `${email.sender_name} <${email.sender_email}>`;
    document.getElementById('modalCompany').innerText = email.company || 'غير محدد';
    document.getElementById('modalDate').innerText = email.date || '';
    document.getElementById('modalSummary').innerText = email.summary || 'لا يوجد ملخص';
    document.getElementById('modalTranslation').innerText = email.translated_body || email.body_snippet || '';
    document.getElementById('modalGmailLink').href = email.gmail_link || '#';

    const actionBox = document.getElementById('modalActionBox');
    if (email.action_required) {
      actionBox.style.display = 'block';
      document.getElementById('modalActionDetails').innerText = email.action_details || 'يرجى مراجعة محتوى الرسالة';
    } else {
      actionBox.style.display = 'none';
    }

    document.getElementById('emailModal').classList.add('active');
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

function closeModal() {
  document.getElementById('emailModal').classList.remove('active');
}

function closeModalOnOverlay(e) {
  if (e.target === document.getElementById('emailModal')) closeModal();
}

async function triggerManualCheck() {
  const btn = document.getElementById('btnRefreshMailTop');
  btn.disabled = true;
  try {
    const res = await fetch('/api/check-now', { method: 'POST' });
    const data = await res.json();
    loadEmails();
    alert(`اكتمل فحص البريد: تمت معالجة ${data.processedCount || 0} رسالة جديدة.`);
  } catch (err) {
    alert('خطأ في فحص البريد: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 10. History & Logs ---------------- //
async function loadHistory() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/history');
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">لا يوجد سجل زمني بعد.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(h => `
      <tr>
        <td><strong>${h.day}</strong></td>
        <td>${h.total_count}</td>
        <td>${h.companies_count}</td>
        <td><span class="badge badge-urgent">${h.urgent_count}</span></td>
        <td><span class="badge badge-important">${h.important_count}</span></td>
        <td><button class="btn btn-secondary btn-sm" onclick="filterByHistoryDate('${h.day}')">عرض رسائل اليوم</button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">خطأ: ${err.message}</td></tr>`;
  }
}

function filterByHistoryDate(dateStr) {
  switchTab('inbox');
  loadEmails();
}

async function loadLogs() {
  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/logs');
    const logs = await res.json();
    if (!Array.isArray(logs) || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">لا توجد سجلات بعد.</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr>
        <td><span style="font-size:0.8rem; color:var(--text-muted);">${formatDateClean(l.timestamp)}</span></td>
        <td><span class="badge ${l.level === 'ERROR' ? 'badge-urgent' : (l.level === 'WARNING' ? 'badge-important' : 'badge-normal')}">${l.level}</span></td>
        <td><strong>${escapeHtml(l.message)}</strong></td>
        <td><span style="font-size:0.82rem; color:var(--text-muted);">${escapeHtml(l.details || '')}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center">خطأ: ${err.message}</td></tr>`;
  }
}

function handleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    loadEmails();
  }, 300);
}

// Helper: Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper: Date Format
function formatDateClean(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}
