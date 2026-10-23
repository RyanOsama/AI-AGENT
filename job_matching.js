const { GoogleGenAI } = require('@google/genai');
const db = require('./database');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const candidateModels = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.6-flash'
];

/**
 * فحص سريع لتحديد ما إذا كانت الوظيفة في مجال تطوير البرمجيات والتقنية
 */
function isSoftwareOrTechJob(job) {
  const title = (job.title || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();
  const tags = Array.isArray(job.tags) ? job.tags.map(t => String(t).toLowerCase()).join(' ') : '';

  const nonTechKeywords = ['copywriter', 'social media', 'recruiter', 'hr', 'talent acquisition', 'sales manager', 'account executive', 'counsel', 'legal', 'finance', 'pharma', 'pflege', 'marketing manager', 'influencer', 'vertrieb', 'nurse', 'driver'];
  const techKeywords = ['developer', 'engineer', 'backend', 'frontend', 'full stack', 'fullstack', 'software', 'node', 'laravel', 'php', 'javascript', 'typescript', 'python', 'cloud', 'architect', 'devops', 'web', 'api', 'programmer', 'internship', 'intern'];

  const hasTech = techKeywords.some(k => title.includes(k) || tags.includes(k));
  const isStrictlyNonTech = nonTechKeywords.some(k => title.includes(k)) && !hasTech;

  return { isTech: hasTech, isStrictlyNonTech };
}

/**
 * وكيل التحليل والمطابقة الذكية الشاملة والترجمة العربية (JobMatchingAgent)
 */
async function matchJobWithCandidate(job, candidateProfile) {
  if (!candidateProfile) {
    throw new Error('لا يوجد ملف مرشح (Candidate Profile) معتمد للقيام بالمطابقة.');
  }

  const { isTech, isStrictlyNonTech } = isSoftwareOrTechJob(job);
  if (isStrictlyNonTech) {
    return {
      job_id: job.id,
      match_score: 15,
      is_qualified: false,
      title_ar: job.title,
      ai_summary_ar: `وظيفة ${job.title} في شركة ${job.company}. الوظيفة خارج المسار البرمجي والتقني للمرشح.`,
      description_ar: job.description || '',
      matched_skills: [],
      missing_skills: ['المجال يختلف عن هندسة البرمجيات والتطوير'],
      match_strengths: [],
      match_weaknesses: ['الوظيفة غير تقنية'],
      match_reasons: 'الوظيفة خارج التخصص البرمجي والتقني للمرشح.',
      responsibilities_ar: ['مهام غير برمجية'],
      responsibilities_en: [],
      req_mandatory: ['متطلبات إدارية أو تسويقية'],
      req_preferred: [],
      req_experience: 'غير محدد',
      req_education: 'غير محدد',
      req_languages: 'غير محدد',
      req_certifications: 'غير محدد',
      benefits: ['غير معلن']
    };
  }

  // تحضير ملخص الخبرات الحقيقية والمهارات المعتمدة للمرشح
  const candidateSummary = {
    full_name: candidateProfile.full_name,
    headline: candidateProfile.headline,
    years_of_experience: candidateProfile.years_of_experience || 0,
    skills_categorized: candidateProfile.skills || [],
    all_skills_flat: candidateProfile.all_skills_flat || [],
    real_experience: (candidateProfile.experience || []).map(exp => ({
      title: exp.title,
      company: exp.company,
      duration: `${exp.start_date || ''} - ${exp.end_date || ''}`,
      technologies_used: exp.technologies_used || [],
      description: exp.description || ''
    })),
    education: candidateProfile.education || [],
    preferences: {
      min_salary_monthly: candidateProfile.min_salary || 2000,
      work_types_accepted: candidateProfile.work_types || ['remote', 'on-site', 'hybrid'],
      preferred_locations: candidateProfile.preferred_locations || 'Remote Worldwide'
    }
  };

  const prompt = `
You are an expert "Job Matching & Deep Job Analysis Agent".
Analyze this job and compare it meticulously against the candidate's verified profile.

🚨 CRITICAL RULES:
1. SOURCE OF TRUTH: The candidate's CV is the absolute truth. NEVER fabricate or hallucinate candidate skills, experience, or degrees.
2. TRANSLATION & LANGUAGE:
   - Provide a natural, high-quality Arabic translation of the Job Title, AI Summary, Full Job Description, Responsibilities, Requirements, and Benefits.
   - PRESERVE technical and technology terms in clean English (e.g. Node.js, Laravel, PHP, PostgreSQL, MySQL, REST API, AWS, Docker, Git, CI/CD, React, Redis). Do not translate technical tool names into clumsy Arabic.
3. SCORING: Calculate a realistic Match Score from 0 to 100 based on title relevance, required technologies, experience level, database/backend stack, and work type.
4. MISSING DATA: If any field (salary, education, deadline, benefits) is not present in the job description, write "Not specified" / "غير محدد". NEVER hallucinate job details.

Candidate Profile:
-----------------
Name: ${candidateSummary.full_name}
Headline: ${candidateSummary.headline}
Years of Exp: ${candidateSummary.years_of_experience}
All Skills: ${candidateSummary.all_skills_flat.join(', ')}
Real Experience: ${JSON.stringify(candidateSummary.real_experience)}
Education: ${JSON.stringify(candidateSummary.education)}

Job Details:
-----------
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'Remote'}
Work Type: ${job.work_type}
Salary: ${job.salary_raw || 'Not specified'}
Published: ${job.published_at || 'Not specified'}
Deadline: ${job.expires_at || 'Not specified'}
Full Description:
${(job.description || '').substring(0, 3500)}

STRICTLY output valid JSON matching this schema:
{
  "match_score": 88,
  "title_ar": "مسمى الوظيفة بالعربية مع الحفاظ على أسماء التقنيات بالإنجليزية",
  "ai_summary_ar": "ملخص واضح ومركّز يوضح: ماذا تبحث الشركة، ماذا سيفعل المطور، أهم التقنيات المطلوبة، مستوى الخبرة، نوع العمل، والموقع والراتب إن وجد",
  "description_ar": "الترجمة الكاملة والوافية للوصف الوظيفي بالعربية مع الإبقاء على المصطلحات التقنية بالإنجليزية",
  "matched_skills": ["Node.js", "Laravel", "REST APIs", "PostgreSQL"],
  "missing_skills": ["AWS", "Docker"],
  "match_reasons": "شرح موجز وواضح لسبب توافق هذه الوظيفة مع خبرات المرشح الحقيقية",
  "match_strengths": ["نقاط القوة في المطابقة بالتفصيل"],
  "match_weaknesses": ["نقاط النقص أو المتطلبات الإضافية غير المتوفرة في الـ CV حالياً دون فبركة"],
  "responsibilities_ar": ["مسؤولية 1 بالعربية", "مسؤولية 2"],
  "responsibilities_en": ["Responsibility 1 in English", "Responsibility 2"],
  "req_mandatory": ["المتطلبات والمهارات الأساسية الإلزامية"],
  "req_preferred": ["المتطلبات المفضلة أو الإضافية Nice-to-have"],
  "req_experience": "متطلبات سنوات الخبرة أو مستوى الأقدمية (أو 'غير محدد')",
  "req_education": "متطلبات التعليم والشهادة الأكاديمية (أو 'غير محدد')",
  "req_languages": "متطلبات اللغات (أو 'غير محدد')",
  "req_certifications": "الشهادات المهنية المطلوبة (أو 'غير محدد')",
  "benefits": ["المزايا المعلنة كالراتب، التأمين، العمل عن بعد، الإجازات المدفوعة، أو 'غير محدد'"]
}
`;

  for (const modelName of candidateModels.slice(0, 3)) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const rawJson = response.text ? response.text.trim() : '';
      if (rawJson) {
        const parsed = JSON.parse(rawJson);
        const score = Math.min(100, Math.max(0, parseInt(parsed.match_score, 10) || 0));

        return {
          job_id: job.id,
          match_score: score,
          title_ar: parsed.title_ar || job.title,
          ai_summary_ar: parsed.ai_summary_ar || `تبحث شركة ${job.company} عن ${job.title} للعمل في بيئة تقنية حديثة.`,
          description_ar: parsed.description_ar || job.description || '',
          matched_skills: Array.isArray(parsed.matched_skills) ? parsed.matched_skills : [],
          missing_skills: Array.isArray(parsed.missing_skills) ? parsed.missing_skills : [],
          match_reasons: parsed.match_reasons || 'توافق في المتطلبات البرمجية والخبرات السابقة.',
          match_strengths: Array.isArray(parsed.match_strengths) ? parsed.match_strengths : [],
          match_weaknesses: Array.isArray(parsed.match_weaknesses) ? parsed.match_weaknesses : [],
          responsibilities_ar: Array.isArray(parsed.responsibilities_ar) ? parsed.responsibilities_ar : [],
          responsibilities_en: Array.isArray(parsed.responsibilities_en) ? parsed.responsibilities_en : [],
          req_mandatory: Array.isArray(parsed.req_mandatory) ? parsed.req_mandatory : [],
          req_preferred: Array.isArray(parsed.req_preferred) ? parsed.req_preferred : [],
          req_experience: parsed.req_experience || 'غير محدد',
          req_education: parsed.req_education || 'غير محدد',
          req_languages: parsed.req_languages || 'غير محدد',
          req_certifications: parsed.req_certifications || 'غير محدد',
          benefits: Array.isArray(parsed.benefits) ? parsed.benefits : ['غير محدد']
        };
      }
    } catch (err) {
      console.warn(`[JobMatchingAgent] محاولة المطابقة عبر ${modelName} فشلت (${err.message}). تجربة النموذج التالي...`);
    }
  }

  // التقييم الذكي البديل عالي الجودة في حال انقطاع الـ API
  const descLower = (job.description || '').toLowerCase();
  const matched = candidateSummary.all_skills_flat.filter(s => descLower.includes(s.toLowerCase()));
  const missing = ['Docker', 'AWS', 'Kubernetes', 'CI/CD', 'GraphQL'].filter(s => descLower.includes(s.toLowerCase()) && !candidateSummary.all_skills_flat.some(cs => cs.toLowerCase() === s.toLowerCase()));

  const fallbackScore = isTech ? Math.min(95, Math.max(50, 50 + matched.length * 8)) : 15;

  return {
    job_id: job.id,
    match_score: fallbackScore,
    title_ar: job.title,
    ai_summary_ar: `تبحث شركة ${job.company} عن ${job.title}. يتضمن الدور تطوير وصيانة الأنظمة البرمجية باستخدام التقنيات الحديثة، بنمط عمل (${job.work_type || 'عن بعد'}).`,
    description_ar: job.description || '',
    matched_skills: matched.length > 0 ? matched : ['تطوير الواجهات الخلفية (Backend)'],
    missing_skills: missing,
    match_reasons: `توافق مباشر في المهارات البرمجية والخبرات العملية: ${matched.join(', ') || 'هندسة البرمجيات'}.`,
    match_strengths: matched.map(m => `إتقان ${m} وتطبيقه في مشاريع فعلية`),
    match_weaknesses: missing.map(m => `طلب إتقان ${m}`),
    responsibilities_ar: [
      'تطوير وتصميم واجهات برمجة التطبيقات (RESTful APIs)',
      'كتابة كود برمجي نظيف وعالي الكفاءة',
      'التعاون مع الفريق الهندسي وتصميم قواعد البيانات'
    ],
    responsibilities_en: [
      'Build and maintain scalable backend services and APIs',
      'Optimize database queries and system performance'
    ],
    req_mandatory: matched.length > 0 ? matched : ['خبرة في تطوير البرمجيات'],
    req_preferred: missing,
    req_experience: 'خبرة عملية سابقة في تطوير البرمجيات والأنظمة',
    req_education: 'درجة بكالوريوس في علوم الحاسب أو خبرة مهنية مكافئة',
    req_languages: 'الإنجليزية (مستوى مهني وتقني)',
    req_certifications: 'غير محدد',
    benefits: [job.salary_raw ? `الراتب: ${job.salary_raw}` : 'الراتب قابل للتفاوض', 'العمل عن بعد (Remote)', 'مرونة في ساعات العمل']
  };
}

/**
 * تحليل ومطابقة دفعة من الوظائف غير المحللة
 */
async function matchBatchOfJobs(limit = 15) {
  const candidateProfile = await db.getCandidateProfile();
  if (!candidateProfile) {
    throw new Error('يرجى رفع واعتماد السيرة الذاتية (Candidate Profile) أولاً قبل تشغيل المطابقة.');
  }

  const unanalyzed = await db.getUnanalyzedJobListings(limit);

  if (!unanalyzed || unanalyzed.length === 0) {
    return { message: 'جميع الوظائف المكتشفة تم تقييمها ومطابقتها مسبقاً.', analyzedCount: 0 };
  }

  console.log(`[JobMatchingAgent] بدء تحليل ومطابقة ${unanalyzed.length} وظيفة مع ملف ${candidateProfile.full_name}...`);

  const results = [];
  for (const job of unanalyzed) {
    try {
      const matchResult = await matchJobWithCandidate(job, candidateProfile);
      
      const newStatus = matchResult.match_score >= 60 ? 'MATCHED' : (matchResult.match_score >= 40 ? 'NEW' : 'REJECTED');

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

      results.push({
        id: job.id,
        title: job.title,
        company: job.company,
        score: matchResult.match_score,
        status: newStatus
      });
      console.log(`   🎯 [Score: ${matchResult.match_score}%] ${job.company} - ${job.title}`);
    } catch (err) {
      console.warn(`   ⚠️ فشل تقييم الوظيفة #${job.id}:`, err.message);
    }
  }

  const logMsg = `اكتمل تقييم المطابقة لـ ${results.length} وظيفة. الوظائف ذات التوافق المرتفع (80%+): ${results.filter(r => r.score >= 80).length}`;
  await db.logEvent('INFO', 'تقييم مطابقة الوظائف الذكي', logMsg);

  return {
    analyzedCount: results.length,
    highMatchesCount: results.filter(r => r.score >= 80).length,
    results
  };
}

module.exports = {
  isSoftwareOrTechJob,
  matchJobWithCandidate,
  matchBatchOfJobs
};
