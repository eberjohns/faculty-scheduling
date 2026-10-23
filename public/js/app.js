// ==========================================================================
// Frontend JavaScript Controller & Department Portal Script
// ==========================================================================

const API_BASE = '/api';

async function authFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  const token = sessionStorage.getItem('token');
  if (token) {
    options.headers['Authorization'] = token;
  }
  return fetch(url, options);
}

// Application State
let state = {
  currentUser: null, // { role: 'department', departmentName: '...' }
  config: null,      // { academicYear, semesterType, semesterLabels, periods }
  departments: [],
  courses: [],       // raw list of all courses
  faculty: [],       // raw list of all faculty
  allocations: {},   // active allocations for department
  selectedDay: 'MONDAY',
  viewMode: 'day',   // 'day' or 'week'
  filters: {
    program: '',
    semester: '',
    category: ''
  },
  allBatches: [],
  groupMappings: {},
  teacherUnavailability: {},
  subjectTeacherMapping: {},
  commonBatches: [],
  allocatedCourseParamSnapshots: (function() {
    try {
      return JSON.parse(sessionStorage.getItem('allocatedCourseParamSnapshots') || '{}');
    } catch (e) {
      return {};
    }
  })()
};

let autosaveTimer = null;

// Helper to format course code with clickable class badge
function formatCourseCodeWithGroup(code, group, mappedBatches = []) {
  const base = code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classMatch = code.match(/(_G|_C)(\d+)/);
  const classNum = classMatch ? parseInt(classMatch[2]) : (group && group > 0 ? group : 0);
  if (classNum && classNum > 0) {
    const titleText = mappedBatches && mappedBatches.length > 0
      ? `Mapped Batches:\n${mappedBatches.join('\n')}`
      : 'No batches mapped';
    return `${base} <span class="badge" title="${titleText}" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; cursor: help; border-radius: 4px;">C${classNum}</span>`;
  }
  return base;
}

// Get the implicitly determined batch based on program, department, semester, and funding
function getImplicitBatch(course) {
  if (!state.currentUser || !state.currentUser.departmentName || !course) return [];
  const deptName = state.currentUser.departmentName.toUpperCase();
  const programCode = course.programType === 'PG' ? 'P' : 'U';
  const fundingCode = '1'; // Default to Aided

  const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
  const deptCode = batchForDept ? batchForDept.deptCode : '';

  const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
  const year = batchForYear ? batchForYear.year : '';

  if (deptCode && year) {
    return [(programCode + fundingCode + deptCode + year).toUpperCase()];
  }
  return [];
}

// Get final batches array for a course (explicit mapping or implicit default fallback)
// If classIndex is provided (e.g. 1, 2), it resolves batches specifically for that class.
function getCourseClassBatches(course, classIndex = null) {
  if (!course) return [];
  const keyWithGroup = course.code.replace(/-(T|P)$/, '');
  const keyWithoutGroup = course.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');

  if (classIndex) {
    const list = state.groupMappings[`${keyWithoutGroup}_C${classIndex}`] || 
                 state.groupMappings[`${keyWithoutGroup}_G${classIndex}`] || 
                 state.groupMappings[`${keyWithGroup}_C${classIndex}`] || [];
    if (list.length > 0) return list;
  } else {
    let mapped = [];
    if (course.classes && course.classes > 1) {
      for (let i = 1; i <= course.classes; i++) {
        const list = state.groupMappings[`${keyWithoutGroup}_C${i}`] || 
                     state.groupMappings[`${keyWithoutGroup}_G${i}`] || 
                     state.groupMappings[`${keyWithGroup}_C${i}`] || [];
        if (list.length > 0) {
          mapped.push(`C${i}: ${list.join('/')}`);
        }
      }
    } else {
      mapped = state.groupMappings[keyWithGroup] || 
               state.groupMappings[keyWithoutGroup] || 
               state.groupMappings[course.code] || [];
    }
    if (mapped.length > 0) {
      return mapped;
    }
  }

  // If this is a grouped/sectioned course (elective), do not fallback to implicit department batch
  const classNumMatch = course.code.match(/(_G|_C)(\d+)/);
  if ((course.group && course.group > 0) || (course.class && course.class > 0) || (classNumMatch && parseInt(classNumMatch[2]) > 0)) {
    return [];
  }

  return getImplicitBatch(course);
}


function isTimetableLocked() {
  if (!state.currentUser || !state.currentUser.departmentName) return false;
  const deptName = state.currentUser.departmentName;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };
  return deptInfo.status === 'Submitted' || deptInfo.status === 'Approved';
}

function applyEditLocksUI() {
  const locked = isTimetableLocked();
  const deptName = state.currentUser ? state.currentUser.departmentName : null;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };

  const btnSaveDraft = document.getElementById('btn-save-draft');
  const btnSubmit = document.getElementById('btn-submit-timetable');
  const btnRevert = document.getElementById('btn-revert-submission');
  const btnSaveAllCourses = document.getElementById('btn-save-all-courses');
  const btnSaveAllFaculty = document.getElementById('btn-save-all-faculty');
  const feedbackCard = document.getElementById('admin-feedback-card');
  const feedbackText = document.getElementById('admin-feedback-text');
  const autosaveStatus = document.getElementById('autosave-status');

  if (locked) {
    if (btnSaveDraft) btnSaveDraft.classList.add('hidden');
    if (btnSubmit) btnSubmit.classList.add('hidden');
    if (btnRevert) {
      if (deptInfo.status === 'Submitted') {
        btnRevert.classList.remove('hidden');
      } else {
        btnRevert.classList.add('hidden');
      }
    }
    if (autosaveStatus) autosaveStatus.textContent = '';
  } else {
    if (btnSaveDraft) btnSaveDraft.classList.remove('hidden');
    if (btnSubmit) btnSubmit.classList.remove('hidden');
    if (btnRevert) btnRevert.classList.add('hidden');
  }

  if (btnSaveAllCourses) btnSaveAllCourses.disabled = locked;
  if (btnSaveAllFaculty) btnSaveAllFaculty.disabled = locked;

  // Feedback Card visibility
  if (deptInfo.status === 'Returned for Changes') {
    if (feedbackCard) feedbackCard.classList.remove('hidden');
    if (feedbackText) feedbackText.textContent = deptInfo.comments || 'Please revise your timetable allocations according to admin requirements.';
  } else {
    if (feedbackCard) feedbackCard.classList.add('hidden');
  }
}

function triggerAutosave() {
  if (isTimetableLocked()) return; // block autosave if locked

  const statusEl = document.getElementById('autosave-status');
  if (statusEl) {
    statusEl.textContent = 'Draft changes pending...';
  }

  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }

  autosaveTimer = setTimeout(async () => {
    if (statusEl) {
      statusEl.textContent = 'Saving draft...';
    }
    
    const deptName = state.currentUser.departmentName;
    try {
      const saveRes = await authFetch(`${API_BASE}/allocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          allocations: state.allocations
        })
      });
      const result = await saveRes.json();
      
      if (!saveRes.ok) {
        if (statusEl) {
          statusEl.textContent = 'Autosave failed: ' + result.message;
        }
        return;
      }
      
      const timeStr = new Date().toLocaleTimeString();
      if (statusEl) {
        statusEl.textContent = `Draft autosaved at ${timeStr}`;
      }
      
      await fetchGlobalData();
      updateDeptStatusBadge();
    } catch (err) {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = 'Autosave failed: Connection error';
      }
    }
  }, 5000);
}

// Custom Modal Alerts Utility (Eliminating browser window alert/confirms)
window.appModal = {
  overlay: document.getElementById('app-modal'),
  icon: document.getElementById('app-modal-icon'),
  title: document.getElementById('app-modal-title'),
  message: document.getElementById('app-modal-message'),
  btnPrimary: document.getElementById('app-modal-btn-primary'),
  btnSecondary: document.getElementById('app-modal-btn-secondary')
};

function showModalAlert(title, message, type = 'info', callback = null) {
  const { overlay, icon, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  if (typeof message === 'string' && message.includes('<')) {
    window.appModal.message.innerHTML = message;
  } else {
    window.appModal.message.textContent = message;
  }
  
  let iconHtml = '<i class="fa-solid fa-circle-info text-primary"></i>';
  if (type === 'success') iconHtml = '<i class="fa-solid fa-circle-check text-success"></i>';
  else if (type === 'warning') iconHtml = '<i class="fa-solid fa-triangle-exclamation text-warning"></i>';
  else if (type === 'danger') iconHtml = '<i class="fa-solid fa-circle-xmark text-danger"></i>';
  window.appModal.icon.innerHTML = iconHtml;
  
  btnSecondary.classList.add('hidden');
  btnPrimary.textContent = "Okay";
  
  // Clone to remove old event listeners
  const newBtn = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtn, btnPrimary);
  window.appModal.btnPrimary = newBtn;
  
  window.appModal.btnPrimary.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (callback) callback();
  });
  
  overlay.classList.remove('hidden');
}

function showModalConfirm(title, message, onConfirm) {
  const { overlay, icon, btnPrimary, btnSecondary } = window.appModal;
  
  window.appModal.title.textContent = title;
  if (typeof message === 'string' && message.includes('<')) {
    window.appModal.message.innerHTML = message;
  } else {
    window.appModal.message.textContent = message;
  }
  window.appModal.icon.innerHTML = '<i class="fa-solid fa-circle-question text-primary"></i>';
  
  btnSecondary.classList.remove('hidden');
  btnSecondary.textContent = "Cancel";
  btnPrimary.textContent = "Confirm";
  
  // Clone primary
  const newBtnPrimary = btnPrimary.cloneNode(true);
  btnPrimary.parentNode.replaceChild(newBtnPrimary, btnPrimary);
  window.appModal.btnPrimary = newBtnPrimary;
  
  // Clone secondary
  const newBtnSecondary = btnSecondary.cloneNode(true);
  btnSecondary.parentNode.replaceChild(newBtnSecondary, btnSecondary);
  window.appModal.btnSecondary = newBtnSecondary;
  
  window.appModal.btnPrimary.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (onConfirm) onConfirm();
  });
  
  window.appModal.btnSecondary.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });
  
  overlay.classList.remove('hidden');
}

// Initializer
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  bindAuthEvents();
  bindDeptEvents();
  bindFilterEvents();
  bindPrintEvents();
  bindFacultySelectEvents();
  bindAutoGeneratorEvents();
  
  // Auto-refresh config when window regains focus or visibility to reflect admin lock/unlock changes
  window.syncGlobalConfigWithAdmin = async function() {
    if (!state.currentUser || !state.currentUser.departmentName) return;
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (res.ok) {
        const freshConfig = await res.json();
        if (freshConfig.commonBatches) {
          state.commonBatches = freshConfig.commonBatches;
        }
        const oldLocks = JSON.stringify((state.config && state.config.globalLockedPeriods) || []);
        const newLocks = JSON.stringify(freshConfig.globalLockedPeriods || []);
        if (oldLocks !== newLocks) {
          state.config = freshConfig;
          renderAllocationMatrix();
          const locksBadge = document.getElementById('auto-gen-global-locks-badge');
          if (locksBadge) {
            locksBadge.textContent = `${(freshConfig.globalLockedPeriods || []).length} Locked`;
          }
        }
      }
    } catch (e) {}
  };

  window.addEventListener('focus', window.syncGlobalConfigWithAdmin);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.syncGlobalConfigWithAdmin();
  });
  setInterval(window.syncGlobalConfigWithAdmin, 4000);
  
  // Restore session
  const savedUser = sessionStorage.getItem('currentUser');
  if (savedUser) {
    state.currentUser = JSON.parse(savedUser);
    document.getElementById('current-user-display').textContent = state.currentUser.departmentName;
    document.getElementById('header-user-info').classList.remove('hidden');
    
    await fetchGlobalData();
    switchView('department');
    await loadDepartmentWorkspace();
  } else {
    await loadLoginDepartments();
    switchView('login');
  }
}

// View toggle
function switchView(viewName) {
  const loginView = document.getElementById('view-login');
  const deptView = document.getElementById('view-department');
  
  if (viewName === 'department') {
    deptView.classList.remove('hidden');
    deptView.classList.add('active');
    loginView.classList.add('hidden');
    loginView.classList.remove('active');
  } else {
    loginView.classList.remove('hidden');
    loginView.classList.add('active');
    deptView.classList.add('hidden');
    deptView.classList.remove('active');
  }
}

async function loadLoginDepartments() {
  try {
    const res = await fetch(`${API_BASE}/departments`);
    const depts = await res.json();
    state.departments = depts;
    
    const dropdown = document.getElementById('login-dept');
    dropdown.innerHTML = '<option value="" disabled selected>Select Department</option>';
    depts.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.name;
      dropdown.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
  }
}

async function fetchGlobalData() {
  try {
    const [configRes, deptsRes, coursesRes, facultyRes, batchesRes, groupRes, unavailRes, mappingRes, commonBatchesRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      authFetch(`${API_BASE}/courses`),
      authFetch(`${API_BASE}/faculty`),
      authFetch(`${API_BASE}/batches`),
      authFetch(`${API_BASE}/admin/group-mappings`),
      authFetch(`${API_BASE}/department/teacher-unavailability`),
      authFetch(`${API_BASE}/department/subject-mapping`),
      authFetch(`${API_BASE}/common-batches`)
    ]);
    
    state.config = await configRes.json();
    state.departments = await deptsRes.json();
    state.courses = await coursesRes.json();
    state.faculty = await facultyRes.json();
    state.allBatches = await batchesRes.json();
    state.groupMappings = await groupRes.json();
    if (unavailRes && unavailRes.ok) {
      state.teacherUnavailability = await unavailRes.json();
    }
    if (mappingRes && mappingRes.ok) {
      state.subjectTeacherMapping = await mappingRes.json();
    }
    if (commonBatchesRes && commonBatchesRes.ok) {
      state.commonBatches = await commonBatchesRes.json();
    } else {
      state.commonBatches = (state.config && state.config.commonBatches) || [];
    }
    // Initialize local subject mappings immediately on startup
    initLocalSubjectMappings();
  } catch (err) {
    console.error(err);
  }
}

// -------------------------------------------------------------
// Authentication Binds
// -------------------------------------------------------------
function bindAuthEvents() {
  const loginForm = document.getElementById('login-form');
  const pwdInput = document.getElementById('login-password');
  const pwdIcon = document.getElementById('toggle-pwd-icon');
  const logoutBtn = document.getElementById('btn-logout');
  const errBox = document.getElementById('login-error');
  
  pwdIcon.addEventListener('click', () => {
    if (pwdInput.type === 'password') {
      pwdInput.type = 'text';
      pwdIcon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
      pwdInput.type = 'password';
      pwdIcon.classList.replace('fa-eye-slash', 'fa-eye');
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const departmentName = document.getElementById('login-dept').value;
    const hiddenUser = document.getElementById('hidden-dept-username');
    if (hiddenUser) hiddenUser.value = departmentName;
    const password = pwdInput.value;
    errBox.classList.add('hidden');
    
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'department', departmentName, password })
      });
      
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || 'Login failed');
      
      state.currentUser = { role: 'department', departmentName, token: result.token };
      sessionStorage.setItem('currentUser', JSON.stringify(state.currentUser));
      sessionStorage.setItem('token', result.token);
      document.getElementById('current-user-display').textContent = departmentName;
      document.getElementById('header-user-info').classList.remove('hidden');
      
      await fetchGlobalData();
      switchView('department');
      await loadDepartmentWorkspace();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('currentUser');
    sessionStorage.removeItem('token');
    state.currentUser = null;
    document.getElementById('header-user-info').classList.add('hidden');
    pwdInput.value = '';
    loadLoginDepartments();
    switchView('login');
  });
}

// -------------------------------------------------------------
// Filters & Toggles Binds
// -------------------------------------------------------------
function bindFilterEvents() {
  const progSelect = document.getElementById('filter-program');
  const semSelect = document.getElementById('filter-semester');
  const catSelect = document.getElementById('filter-category');
  const termToggleContainer = document.getElementById('term-quick-toggle');
  
  const updateTermQuickToggleButtons = (activeVal) => {
    if (!termToggleContainer) return;
    const termBtns = termToggleContainer.querySelectorAll('button');
    termBtns.forEach(b => {
      const bTerm = b.getAttribute('data-term');
      if ((bTerm === activeVal) || (!bTerm && !activeVal)) {
        b.style.background = '#ffffff';
        b.style.color = 'var(--primary)';
        b.style.fontWeight = '700';
        b.style.boxShadow = '0 1px 2px rgba(0,0,0,0.08)';
      } else {
        b.style.background = 'transparent';
        b.style.color = '#475569';
        b.style.fontWeight = '600';
        b.style.boxShadow = 'none';
      }
    });
  };

  if (termToggleContainer) {
    const termBtns = termToggleContainer.querySelectorAll('button');
    termBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const term = btn.getAttribute('data-term');
        state.filters.semester = term;
        if (semSelect) semSelect.value = term;
        updateTermQuickToggleButtons(term);
        renderAllocationMatrix();
      });
    });
  }

  if (progSelect) {
    progSelect.addEventListener('change', () => {
      state.filters.program = progSelect.value;
      populateFilters();
      renderAllocationMatrix();
    });
  }
  
  if (semSelect) {
    semSelect.addEventListener('change', () => {
      state.filters.semester = semSelect.value;
      updateTermQuickToggleButtons(semSelect.value);
      renderAllocationMatrix();
    });
  }
  
  if (catSelect) {
    catSelect.addEventListener('change', () => {
      state.filters.category = catSelect.value;
      renderAllocationMatrix();
    });
  }

  // Dynamic filter lists population
  function populateFilters() {
    const deptName = state.currentUser.departmentName;
    let deptCourses = state.courses.filter(c => c.department === deptName);
    
    // Apply program filter to find available semesters and categories
    if (state.filters.program) {
      deptCourses = deptCourses.filter(c => (c.programType || 'UG') === state.filters.program);
    }
    
    // Semesters
    const sems = Array.from(new Set(deptCourses.map(c => c.semester))).sort();
    const prevSelectedSem = state.filters.semester;
    
    semSelect.innerHTML = `
      <option value="">All Semesters</option>
      <option value="odd">Odd Semesters (1, 3, 5)</option>
      <option value="even">Even Semesters (2, 4)</option>
    `;
    sems.forEach(s => {
      let label = state.config.semesterLabels[s] || `Sem ${s}`;
      
      // Determine what program types exist for this semester in the filtered list
      const coursePrograms = Array.from(new Set(deptCourses.filter(c => c.semester === s).map(c => c.programType || 'UG')));
      if (coursePrograms.length === 1) {
        label = getSemesterLabel(s, coursePrograms[0]);
      } else if (coursePrograms.length > 1) {
        label = `${getSemesterLabel(s, 'UG')} / ${getSemesterLabel(s, 'PG')}`;
      }
      
      semSelect.innerHTML += `<option value="${s}">${label}</option>`;
    });
    
    if (['', 'odd', 'even'].includes(prevSelectedSem) || sems.includes(prevSelectedSem)) {
      semSelect.value = prevSelectedSem;
    } else {
      state.filters.semester = '';
      semSelect.value = '';
    }
    updateTermQuickToggleButtons(semSelect.value);

    // Categories
    const cats = Array.from(new Set(deptCourses.map(c => c.category))).sort();
    const prevSelectedCat = state.filters.category;
    
    catSelect.innerHTML = '<option value="">All Categories</option>';
    cats.forEach(c => {
      catSelect.innerHTML += `<option value="${c}">${c}</option>`;
    });
    
    if (cats.includes(prevSelectedCat)) {
      catSelect.value = prevSelectedCat;
    } else {
      state.filters.category = '';
      catSelect.value = '';
    }
  }

  function getSemesterLabel(s, program) {
    const baseLabel = state.config.semesterLabels[s] || `Sem ${s}`;
    if (program === 'PG') {
      if (baseLabel.toUpperCase().includes('BSC')) {
        return baseLabel.replace(/BSC/i, 'MSC');
      }
      return `${baseLabel} MSC`;
    } else if (program === 'UG') {
      if (baseLabel.toUpperCase().includes('BSC')) {
        return baseLabel;
      }
      return `${baseLabel} BSC`;
    }
    return baseLabel;
  }

  // Hook populateFilters to trigger when loading workspace
  window.populateFiltersDropdowns = populateFilters;
}

// -------------------------------------------------------------
// Department Workspace
// -------------------------------------------------------------
async function loadDepartmentWorkspace() {
  const deptName = state.currentUser.departmentName;
  document.getElementById('dept-title-name').textContent = `Department of ${deptName}`;
  
  try {
    const [allocRes, configRes] = await Promise.all([
      authFetch(`${API_BASE}/allocations?department=${deptName}`),
      fetch(`${API_BASE}/config`)
    ]);
    state.allocations = await allocRes.json();
    if (configRes && configRes.ok) {
      state.config = await configRes.json();
    }
    
    updateDeptStatusBadge();
    window.populateFiltersDropdowns();
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
    renderDeptDataEditors();
    renderTeacherAvailabilityEditor();
    populateTeacherTimetableDropdowns();
    renderTeacherTimetablesTab();
    applyEditLocksUI();
  } catch (err) {
    console.error(err);
  }
}

function updateDeptStatusBadge() {
  const deptName = state.currentUser.departmentName;
  const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft', comments: '' };
  
  const badge = document.getElementById('dept-status-badge');
  badge.textContent = deptInfo.status;
  badge.className = 'badge';
  
  if (deptInfo.status === 'Approved') badge.classList.add('badge-info');
  else if (deptInfo.status === 'Submitted') badge.classList.add('recommend-p');
  else if (deptInfo.status === 'Returned for Changes') badge.classList.add('recommend-t');
  else badge.classList.add('recommend-none');
}

function bindDeptEvents() {
  // Day tab switch
  document.querySelectorAll('.weekday-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.weekday-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.selectedDay = tab.getAttribute('data-day');
      renderAllocationMatrix();
    });
  });

  // Toggle Grid View Mode (Single Day vs Full Week)
  document.getElementById('btn-toggle-grid-mode').addEventListener('click', () => {
    const btn = document.getElementById('btn-toggle-grid-mode');
    const daySelector = document.getElementById('weekday-selector-wrapper');
    const fullWeekHeader = document.getElementById('full-week-header-label');
    
    if (state.viewMode === 'day') {
      state.viewMode = 'week';
      btn.innerHTML = '<i class="fa-solid fa-calendar-day"></i> Switch to Day View';
      daySelector.style.display = 'none';
      fullWeekHeader.style.display = 'block';
    } else {
      state.viewMode = 'day';
      btn.innerHTML = '<i class="fa-solid fa-table-cells"></i> Switch to Full Week View';
      daySelector.style.display = 'flex';
      fullWeekHeader.style.display = 'none';
    }
    renderAllocationMatrix();
  });

  // Format Excel & Import Timetable Buttons
  const btnFormatExcel = document.getElementById('btn-dept-format-excel');
  const btnImportExcel = document.getElementById('btn-dept-import-excel');
  const fileInputDept = document.getElementById('import-dept-timetable-file');
  const modalFormat = document.getElementById('modal-dept-excel-format');
  const btnCloseFormat1 = document.getElementById('btn-close-dept-excel-format');
  const btnCloseFormat2 = document.getElementById('btn-close-dept-excel-format-secondary');
  const btnDownloadTemplate = document.getElementById('btn-download-dept-template');

  function downloadDepartmentTemplate() {
    if (!state.currentUser || !state.currentUser.departmentName) return;
    const deptName = encodeURIComponent(state.currentUser.departmentName);
    const token = sessionStorage.getItem('token') || '';
    window.location.href = `${API_BASE}/department/import-template?department=${deptName}&token=${encodeURIComponent(token)}`;
  }

  if (btnFormatExcel) {
    btnFormatExcel.addEventListener('click', () => {
      if (modalFormat) modalFormat.classList.remove('hidden');
    });
  }

  if (btnCloseFormat1) {
    btnCloseFormat1.addEventListener('click', () => modalFormat.classList.add('hidden'));
  }
  if (btnCloseFormat2) {
    btnCloseFormat2.addEventListener('click', () => modalFormat.classList.add('hidden'));
  }

  if (btnDownloadTemplate) {
    btnDownloadTemplate.addEventListener('click', () => {
      downloadDepartmentTemplate();
    });
  }

  if (btnImportExcel && fileInputDept) {
    btnImportExcel.addEventListener('click', () => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert('Timetable Locked', `Your department timetable is locked because it is currently ${deptInfo.status}. Editing or importing allocations is disabled.`, 'warning');
        return;
      }
      fileInputDept.click();
    });

    fileInputDept.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);
      formData.append('departmentName', state.currentUser.departmentName);

      try {
        const res = await authFetch(`${API_BASE}/department/import-timetable`, {
          method: 'POST',
          body: formData
        });

        const result = await res.json();
        fileInputDept.value = ''; // Reset input

        if (res.ok && result.success) {
          let warnMsg = '';
          if (result.warnings && result.warnings.length > 0) {
            warnMsg = '\n\nNote:\n' + result.warnings.slice(0, 5).join('\n') + (result.warnings.length > 5 ? `\n...and ${result.warnings.length - 5} more warnings.` : '');
          }
          showModalAlert('Import Successful', result.message + warnMsg, 'success', async () => {
            await fetchGlobalData();
            await loadDepartmentWorkspace();
          });
        } else {
          let clashDetails = '';
          if (result.clashes && result.clashes.length > 0) {
            clashDetails = '\n\nClashes detected:\n' + result.clashes.map(c => `• ${c.facultyCode} double booked on ${c.weekday} P${c.period} (${c.courses.join(', ')})`).join('\n');
          }
          showModalAlert('Import Failed', (result.message || result.error || 'Failed to import timetable.') + clashDetails, 'danger');
        }
      } catch (err) {
        console.error(err);
        fileInputDept.value = '';
        showModalAlert('Error', 'Connection error while uploading timetable Excel.', 'danger');
      }
    });
  }

  // Clear Semester Timetable Button
  const btnClearSem = document.getElementById('btn-clear-sem-timetable');
  if (btnClearSem) {
    btnClearSem.addEventListener('click', () => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert('Timetable Locked', `Your department timetable is locked because it is currently ${deptInfo.status}. Clearing allocations is disabled.`, 'warning');
        return;
      }

      const activeSem = state.filters.semester;
      let targetLabel = 'All Semesters';
      if (activeSem === 'odd') targetLabel = 'Odd Semesters (1, 3, 5)';
      else if (activeSem === 'even') targetLabel = 'Even Semesters (2, 4)';
      else if (activeSem) targetLabel = `Semester ${activeSem}`;

      showModalConfirm(
        `Clear ${targetLabel} Allocations?`,
        `Are you sure you want to clear all timetable allocations for ${targetLabel}? All faculty assignments for these courses will be removed.`,
        async () => {
          try {
            const res = await authFetch(`${API_BASE}/department/clear-semester`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                departmentName: state.currentUser.departmentName,
                semester: activeSem || 'all'
              })
            });
            const result = await res.json();
            if (res.ok && result.success) {
              const deptName = state.currentUser.departmentName;
              let deptCourses = state.courses.filter(c => c.department === deptName);
              if (activeSem === 'odd') {
                deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 1);
              } else if (activeSem === 'even') {
                deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 0);
              } else if (activeSem) {
                deptCourses = deptCourses.filter(c => String(c.semester) === String(activeSem));
              }
              const targetBases = new Set(deptCourses.map(c => c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '')));
              Object.keys(state.allocations).forEach(cCode => {
                const base = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');
                if (targetBases.has(base) || targetBases.has(cCode)) {
                  delete state.allocations[cCode];
                }
              });
              renderAllocationMatrix();
              updateDeptLiveWorkloadTracker();
              triggerAutosave();
              showModalAlert('Timetable Cleared', result.message, 'success');
            } else {
              showModalAlert('Clear Failed', result.message || 'Failed to clear timetable.', 'danger');
            }
          } catch (err) {
            console.error(err);
            showModalAlert('Error', 'Connection error while clearing timetable.', 'danger');
          }
        }
      );
    });
  }

  // Advanced Features Modal opening button at top of workspace
  const btnAdvFeatures = document.getElementById('btn-open-advanced-features');
  if (btnAdvFeatures) {
    btnAdvFeatures.addEventListener('click', () => {
      openAdvancedFeaturesModal();
    });
  }

  // Department Sub-tabs for inline editors
  document.querySelectorAll('.tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const subId = btn.getAttribute('data-subtab');
      document.querySelectorAll('.subtab-pane').forEach(p => {
        if (p.id === subId) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });

      if (subId === 'subtab-dept-availability') {
        renderTeacherAvailabilityEditor();
      }
      if (subId === 'subtab-dept-teacher-timetable') {
        renderTeacherTimetablesTab();
      }
    });
  });


  // Teacher Availability Controls
  const selectAvailTeacher = document.getElementById('select-avail-teacher');
  if (selectAvailTeacher) {
    let prevSelectedTeacher = selectAvailTeacher.value;
    selectAvailTeacher.addEventListener('focus', () => {
      prevSelectedTeacher = selectAvailTeacher.value;
    });
    selectAvailTeacher.addEventListener('change', () => {
      const nextTeacherCode = selectAvailTeacher.value;
      const unsaved = getTeacherUnavailUnsavedChanges();
      if (unsaved && unsaved.changes && unsaved.changes.length > 0) {
        showUnsavedChangesModal(unsaved, () => {
          activeUnavailTeacherCode = nextTeacherCode;
          prevSelectedTeacher = nextTeacherCode;
          selectAvailTeacher.value = nextTeacherCode;
          const allUnavail = state.teacherUnavailability || {};
          localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
          updateTeacherUnavailSnapshot();
          loadTeacherUnavailMatrix();
        });
        selectAvailTeacher.value = prevSelectedTeacher;
        return;
      }
      activeUnavailTeacherCode = nextTeacherCode;
      prevSelectedTeacher = nextTeacherCode;
      const allUnavail = state.teacherUnavailability || {};
      localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
      updateTeacherUnavailSnapshot();
      loadTeacherUnavailMatrix();
    });
  }

  const btnClearTeacherUnavail = document.getElementById('btn-clear-teacher-unavail');
  if (btnClearTeacherUnavail) {
    btnClearTeacherUnavail.addEventListener('click', () => {
      if (isTimetableLocked()) return;
      localTeacherUnavail = [];
      loadTeacherUnavailMatrix();
    });
  }

  const btnSaveTeacherUnavail = document.getElementById('btn-save-teacher-unavailability');
  if (btnSaveTeacherUnavail) {
    btnSaveTeacherUnavail.addEventListener('click', async () => {
      if (isTimetableLocked()) {
        showModalAlert('Timetable Locked', 'Timetable is locked. Modifying teacher availability is disabled.', 'warning');
        return;
      }
      if (!activeUnavailTeacherCode) return;

      try {
        const res = await authFetch(`${API_BASE}/department/teacher-unavailability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            facultyCode: activeUnavailTeacherCode,
            unavailableSlots: localTeacherUnavail,
            departmentName: state.currentUser.departmentName
          })
        });
        const result = await res.json();
        if (res.ok && result.success) {
          if (!state.teacherUnavailability) state.teacherUnavailability = {};
          state.teacherUnavailability[activeUnavailTeacherCode] = localTeacherUnavail;
          updateTeacherUnavailSnapshot();
          showModalAlert('Saved', `Availability updated for ${activeUnavailTeacherCode}.`, 'success');
        } else {
          showModalAlert('Error', result.message || 'Failed to save availability.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Connection error while saving availability.', 'danger');
      }
    });
  }

  // Bottom action buttons
  const saveDraftBtn = document.getElementById('btn-save-draft');
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', () => {
      saveDepartmentAllocations(false);
    });
  }
  document.getElementById('btn-submit-timetable').addEventListener('click', () => {
    saveDepartmentAllocations(true);
  });
  document.getElementById('btn-preview-timetable').addEventListener('click', () => {
    openTimetablePrintPreview(state.currentUser.departmentName);
  });
  bindTeacherTimetableEvents();
  
  const btnRevert = document.getElementById('btn-revert-submission');
  if (btnRevert) {
    btnRevert.addEventListener('click', () => {
      const deptName = state.currentUser.departmentName;
      showModalConfirm(
        'Revert Submission?',
        'Are you sure you want to revert your submission back to Draft? This will allow you to edit your timetable allocations again.',
        async () => {
          try {
            const res = await authFetch(`${API_BASE}/submissions/status`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                departmentName: deptName,
                status: 'Draft',
                comments: 'Reverted to Draft by department coordinator.'
              })
            });
            if (res.ok) {
              showModalAlert('Success', 'Submission reverted to Draft. You can now edit the timetable.', 'success');
              await fetchGlobalData();
              await loadDepartmentWorkspace();
            } else {
              const err = await res.json();
              showModalAlert('Error', err.message || 'Failed to revert submission.', 'danger');
            }
          } catch (err) {
            console.error(err);
            showModalAlert('Error', 'Connection error while reverting submission.', 'danger');
          }
        }
      );
    });
  }

  // Department Group & Batch Assignment Modal Events
  const modalDeptMapping = document.getElementById('modal-dept-group-mapping');
  const btnCloseDeptMapping = document.getElementById('btn-close-dept-group-mapping-modal');
  const btnSaveDeptMapping = document.getElementById('btn-save-dept-group-mapping');
  const deptGroupCountSelect = document.getElementById('dept-group-count-select');

  if (btnCloseDeptMapping) {
    btnCloseDeptMapping.addEventListener('click', () => {
      modalDeptMapping.classList.add('hidden');
    });
  }

  if (deptGroupCountSelect) {
    deptGroupCountSelect.addEventListener('change', () => {
      const courseCode = document.getElementById('dept-mapping-course-code').value;
      const course = state.courses.find(c => c.code === courseCode);
      if (!course) return;

      const deptName = state.currentUser.departmentName.toUpperCase();
      const programCode = course.programType === 'PG' ? 'P' : 'U';
      const fundingCode = '1';

      const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
      const deptCode = batchForDept ? batchForDept.deptCode : '';

      const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
      const year = batchForYear ? batchForYear.year : '';

      const defaultBatchId = (programCode + fundingCode + deptCode + year).toUpperCase();

      renderDeptGroupSelects(course, defaultBatchId);
    });
  }

  if (btnSaveDeptMapping) {
    btnSaveDeptMapping.addEventListener('click', async () => {
      const courseCode = document.getElementById('dept-mapping-course-code').value;
      const countVal = parseInt(deptGroupCountSelect.value) || 1;
      
      const selects = document.querySelectorAll('.dept-group-select-item');
      const selectedBatches = Array.from(selects).map(s => s.value);

      try {
        const res = await authFetch(`${API_BASE}/courses/class-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseCode,
            classes: countVal,
            batches: selectedBatches,
            departmentName: state.currentUser.departmentName
          })
        });

        if (res.ok) {
          modalDeptMapping.classList.add('hidden');
          showModalAlert('Success', 'Class configurations and batch mappings updated successfully!', 'success');
          await fetchGlobalData();
          await loadDepartmentWorkspace();
        } else {
          const err = await res.json();
          showModalAlert('Error', err.message || 'Failed to save changes.', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Connection error while saving mappings.', 'danger');
      }
    });
  }



  // Save All buttons
  document.getElementById('btn-save-all-courses').addEventListener('click', async () => {
    const deptName = state.currentUser.departmentName;
    const deptCourses = state.courses.filter(c => c.department === deptName);
    const coursesToSave = deptCourses.map(c => {
      const alias = document.getElementById(`calias-${c.code}`).value.trim();
      return { code: c.code, name: c.name, alias };
    });

    try {
      const res = await authFetch(`${API_BASE}/courses/alias/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses: coursesToSave, departmentName: deptName })
      });
      if (res.ok) {
        showModalAlert('Success', 'All course details updated successfully!', 'success');
        await fetchGlobalData();
        renderAllocationMatrix();
        renderDeptDataEditors();
      } else {
        const err = await res.json();
        showModalAlert('Error', err.message || 'Failed to update courses.', 'danger');
        renderDeptDataEditors();
      }
    } catch (err) {
      console.error(err);
      showModalAlert('Error', 'Failed to communicate with server.', 'danger');
      renderDeptDataEditors();
    }
  });

  document.getElementById('btn-save-all-faculty').addEventListener('click', async () => {
    const deptName = state.currentUser.departmentName;
    const deptFaculty = state.faculty.filter(f => f.department === deptName);
    const facultyToSave = deptFaculty.map(f => {
      const code = document.getElementById(`fcode-${f.staffId}`).value.trim();
      return { staffId: f.staffId, code };
    });

    try {
      const res = await authFetch(`${API_BASE}/faculty/code/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faculty: facultyToSave, departmentName: deptName })
      });
      if (res.ok) {
        showModalAlert('Success', 'All faculty initials codes updated successfully!', 'success');
        await fetchGlobalData();
        await loadDepartmentWorkspace();
      } else {
        const err = await res.json();
        let explanation = err.message || 'Failed to update faculty codes.';
        if (explanation.includes('already assigned')) {
          explanation += '\n\nNote: Faculty visual initials codes must be unique across the entire college to prevent scheduling overlaps and distinguish between faculty members during allocation.';
        }
        showModalAlert('Conflict Error', explanation, 'danger');
        renderDeptDataEditors();
      }
    } catch (err) {
      console.error(err);
      showModalAlert('Error', 'Failed to communicate with server.', 'danger');
      renderDeptDataEditors();
    }
  });
}


// Dynamic Row Merge Layout & Matrix Compiler
function renderAllocationMatrix() {
  const deptName = state.currentUser.departmentName;
  const periods = state.config.periods;
  const table = document.getElementById('table-allocation-matrix');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  // Clean table styling
  table.className = 'table table-grid';
  const locked = isTimetableLocked();
  
  // Filter courses for this department
  let deptCourses = state.courses.filter(c => c.department === deptName);
  
  // Apply Dropdown Filters
  if (state.filters.program) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === state.filters.program);
  }
  if (state.filters.semester) {
    if (state.filters.semester === 'odd') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 1);
    } else if (state.filters.semester === 'even') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 0);
    } else {
      deptCourses = deptCourses.filter(c => String(c.semester) === String(state.filters.semester));
    }
  }
  if (state.filters.category) {
    deptCourses = deptCourses.filter(c => c.category === state.filters.category);
  }

  // Merge theory (-T) and practical (-P) courses sharing same base code into unique list
  const baseCourseCodes = Array.from(new Set(deptCourses.map(c => c.code.replace(/-(T|P)$/, '')))).sort();

  // -----------------------------------------------------------
  // CASE A: FULL WEEK VIEW (30 period columns)
  // -----------------------------------------------------------
  if (state.viewMode === 'week') {
    table.classList.add('full-week-mode');
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    const weekdaysShort = ["MON", "TUE", "WED", "THU", "FRI"];
    
    // Build headers double row
    let headerRow1 = `<tr><th rowspan="2" style="min-width:110px; text-align:left;">Course Code</th><th rowspan="2" style="min-width:160px; text-align:left;">Course Name / Alias</th>`;
    let headerRow2 = `<tr>`;
    
    weekdays.forEach((day, dIdx) => {
      // Calculate period count to set colspan
      headerRow1 += `<th colspan="${periods.length}" style="border-bottom:2px solid var(--primary);">${weekdaysShort[dIdx]}</th>`;
      periods.forEach(p => {
        headerRow2 += `<th>${p}</th>`;
      });
    });
    headerRow1 += `</tr>`;
    headerRow2 += `</tr>`;
    thead.innerHTML = headerRow1 + headerRow2;

    tbody.innerHTML = '';
    if (baseCourseCodes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${5 * periods.length + 2}" class="text-center text-muted">No courses found matching active filters.</td></tr>`;
      return;
    }

    baseCourseCodes.forEach(baseCode => {
      const { courseT, courseP, dispName, dispAlias, sem, cat, group, mappedBatches, classes } = getMergedCourseInfo(baseCode, deptCourses);
      
      const count = classes > 1 ? classes : 1;
      for (let cl = 1; cl <= count; cl++) {
        const isCloned = classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const rowBatchesWeek = getCourseClassBatches(activeCourseRef, isCloned ? cl : null);
        const classNumMatch = baseCode.match(/(_G|_C)(\d+)/);
        const inferredClass = isCloned ? cl : (classNumMatch ? parseInt(classNumMatch[2]) : (group && group > 0 ? group : null));
        const cleanBaseCode = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const cleanAlias = (dispAlias || cleanBaseCode).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const rowAlias = inferredClass ? `${cleanAlias} (C${inferredClass})` : cleanAlias;
        const classBadgeTooltip = rowBatchesWeek.length > 0 ? `Batch: ${rowBatchesWeek.join(', ')}` : 'No batch mapped';
        const formattedCode = inferredClass
          ? `${cleanBaseCode} <span class="badge" title="${classBadgeTooltip}" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px; cursor: help;">C${inferredClass}</span>`
          : cleanBaseCode;
        
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">
            ${formattedCode}
            <button class="btn btn-outline btn-xs btn-matrix-class-cfg" title="Configure Classes & Batches" style="padding: 1px 5px; font-size: 10px; margin-left: 6px; line-height: 1.2; border-radius: 3px; vertical-align: middle;" onclick="event.stopPropagation(); openDeptBatchMappingModal('${cleanBaseCode}')" ${locked ? 'disabled' : ''}>
              <i class="fa-solid fa-layer-group"></i>
            </button>
          </td>
          <td style="text-align:left;" title="${dispName}">
            <span class="badge badge-info">${rowAlias}</span>
          </td>
        `;

        // Render cells sequentially for MON-FRI and P1-P6
        weekdays.forEach(day => {
          periods.forEach(p => {
            const td = document.createElement('td');
            if (p.toUpperCase() === 'LB') {
              td.className = 'slot-lb';
              td.textContent = 'LB';
              tr.appendChild(td);
              return;
            }

            const cellHtml = renderCellSlot(baseCode, courseT, courseP, day, p, isCloned ? cl : null);
            td.className = cellHtml.classes;
            td.innerHTML = cellHtml.html;
            tr.appendChild(td);
          });
        });

        tbody.appendChild(tr);
      }
    });

  // -----------------------------------------------------------
  // CASE B: SINGLE DAY VIEW
  // -----------------------------------------------------------
  } else {
    // 1. Build Header
    let headerHtml = `
      <tr>
        <th style="min-width:120px; text-align:left;">Course Code</th>
        <th style="min-width:180px; text-align:left;">Course Name / Alias</th>
        <th style="width:70px;">Sem.</th>
        <th style="width:80px;">Category</th>
        <th style="min-width:120px; text-align:left;">Batches</th>
    `;
    periods.forEach(p => {
      headerHtml += `<th style="width:120px;">${p}</th>`;
    });
    headerHtml += `</tr>`;
    thead.innerHTML = headerHtml;

    tbody.innerHTML = '';
    if (baseCourseCodes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${periods.length + 5}" class="text-center text-muted">No courses found matching active filters.</td></tr>`;
      return;
    }

    baseCourseCodes.forEach(baseCode => {
      const { courseT, courseP, dispName, dispAlias, sem, cat, group, mappedBatches, classes } = getMergedCourseInfo(baseCode, deptCourses);
      
      const count = classes > 1 ? classes : 1;
      for (let cl = 1; cl <= count; cl++) {
        const isCloned = classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const rowBatches = getCourseClassBatches(activeCourseRef, isCloned ? cl : null);
        const classNumMatch = baseCode.match(/(_G|_C)(\d+)/);
        const inferredClass = isCloned ? cl : (classNumMatch ? parseInt(classNumMatch[2]) : (group && group > 0 ? group : null));
        const cleanBaseCode = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const cleanAlias = (dispAlias || cleanBaseCode).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const rowAlias = inferredClass ? `${cleanAlias} (C${inferredClass})` : cleanAlias;
        const formattedCode = inferredClass
          ? `${cleanBaseCode} <span class="badge" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px;">C${inferredClass}</span>`
          : cleanBaseCode;
          
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">
            ${formattedCode}
            <button class="btn btn-outline btn-xs btn-matrix-class-cfg" title="Configure Classes & Batches" style="padding: 1px 5px; font-size: 10px; margin-left: 6px; line-height: 1.2; border-radius: 3px; vertical-align: middle;" onclick="event.stopPropagation(); openDeptBatchMappingModal('${cleanBaseCode}')" ${locked ? 'disabled' : ''}>
              <i class="fa-solid fa-layer-group"></i>
            </button>
          </td>
          <td style="text-align:left;">
            <span class="badge badge-info">${rowAlias}</span>
            <div class="text-sm bold text-muted">${dispName}</div>
          </td>
          <td>${sem}</td>
          <td>${cat}</td>
          <td style="text-align:left;">
            ${rowBatches.length > 0
              ? rowBatches.map(b => `<span class="badge badge-info" style="margin:2px; font-size:11px;">${b}</span>`).join('')
              : '<span class="text-muted text-sm">-</span>'}
          </td>
        `;

        periods.forEach(p => {
          const td = document.createElement('td');
          if (p.toUpperCase() === 'LB') {
            td.className = 'slot-lb';
            td.textContent = 'LB';
            tr.appendChild(td);
            return;
          }

          const cellHtml = renderCellSlot(baseCode, courseT, courseP, state.selectedDay, p, isCloned ? cl : null);
          td.className = cellHtml.classes;
          td.innerHTML = cellHtml.html;
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      }
    });
  }
}

// Merges data representation of -T and -P suffixes
function getMergedCourseInfo(baseCode, deptCourses) {
  let courseT = deptCourses.find(c => c.code === `${baseCode}-T`);
  let courseP = deptCourses.find(c => c.code === `${baseCode}-P`);
  
  if (!courseT && !courseP) {
    const fallbackCourse = deptCourses.find(c => c.code === baseCode);
    if (fallbackCourse) {
      courseT = fallbackCourse;
    }
  }
  
  const activeCourse = courseT || courseP || { name: baseCode, alias: baseCode, semester: '-', category: '-', group: 0, mappedBatches: [], classes: 1 };
  
  return {
    courseT,
    courseP,
    dispName: activeCourse.name.replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, ''),
    dispAlias: (activeCourse.alias || baseCode).replace(/-(T|P)$/, ''),
    sem: activeCourse.semester,
    cat: activeCourse.category,
    group: activeCourse.group || 0,
    mappedBatches: activeCourse.mappedBatches || [],
    classes: activeCourse.classes || 1
  };
}


function courseMatchesCommonSubject(course, subjectCode, commonBatches = []) {
  if (!course) return false;
  const norm = (subjectCode || '').toUpperCase().trim();
  const cCode = (course.code || course.courseCode || '').toUpperCase().trim();
  const baseCode = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
  const cat = (course.category || '').toUpperCase().trim();
  const name = (course.name || course.courseName || '').toUpperCase().trim();
  const dept = (course.department || '').toUpperCase().trim();
  const cSem = String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();

  // 1. Direct common batch linkage
  if (Array.isArray(commonBatches)) {
    const hasBatch = commonBatches.some(b => {
      const bSubj = (b.subjectCode || '').toUpperCase().trim();
      const bCourse = (b.courseCode || '').toUpperCase().trim();
      const bBase = bCourse.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
      if (bSubj !== norm && !(norm.startsWith('MDC') && bSubj.startsWith('MDC'))) return false;
      return bCourse === cCode || bBase === baseCode || cCode.startsWith(bCourse) || bCourse.startsWith(baseCode);
    });
    if (hasBatch) return true;
  }

  // 2. MDC match (MDC1 in Sem 1, MDC-2 in Sem 2, MDC3 in Sem 3, or general MDC)
  if (norm.startsWith('MDC')) {
    if (norm === 'MDC1' && cSem !== '1') return false;
    if ((norm === 'MDC-2' || norm === 'MDC2') && cSem !== '2') return false;
    if (norm === 'MDC3' && cSem !== '3') return false;
    const isMdc = cat === 'MDC' || cat.includes('MDC') || cat.includes('MULTI') || 
                  cCode.includes('FM') || cCode.includes('MDC') || 
                  name.includes('MDC') || name.includes('MULTIDISCIPLINARY') || name.includes('MULTI-DISCIPLINARY');
    return isMdc;
  }

  // 3. AEC match
  if (norm === 'AEC1') {
    if (cSem !== '1') return false;
    return (cat === 'AEC' || cCode.includes('FA') || cCode.includes('AEC')) && dept === 'ENGLISH';
  }
  if (norm === 'AEC2') {
    if (cSem !== '1') return false;
    return (cat === 'AEC' || cCode.includes('FA') || cCode.includes('AEC')) && ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'].includes(dept);
  }
  if (norm === 'AEC3') {
    if (cSem !== '2') return false;
    return (cat === 'AEC' || cCode.includes('FA') || cCode.includes('AEC')) && dept === 'ENGLISH';
  }
  if (norm === 'AEC4') {
    if (cSem !== '2') return false;
    return (cat === 'AEC' || cCode.includes('FA') || cCode.includes('AEC')) && ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'].includes(dept);
  }

  // 4. VAC match
  if (norm === 'VAC1') {
    if (cSem !== '3') return false;
    return (cat === 'VAC' || cCode.includes('FV') || cCode.includes('VAC')) && dept === 'ENGLISH';
  }
  if (norm === 'VAC2') {
    if (cSem !== '4') return false;
    return (cat === 'VAC' || cCode.includes('FV') || cCode.includes('VAC')) && dept === 'ENGLISH';
  }
  if (norm === 'VAC3') {
    if (cSem !== '4') return false;
    return (cat === 'VAC' || cCode.includes('FV') || cCode.includes('VAC')) && ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'].includes(dept);
  }

  // 5. SEC match
  if (norm === 'SEC') {
    if (cSem !== '4') return false;
    return (cat === 'SEC' || cCode.includes('SEC') || cCode.includes('FS')) && dept === 'ENGLISH';
  }

  return false;
}

function isPeriodLockedForCourse(lock, course, day, period, commonBatches = []) {
  if (!lock) return false;
  if (lock.day.toUpperCase() !== day.toUpperCase()) return false;
  if (String(lock.period).trim() !== String(period).trim()) return false;

  const lockSem = String(lock.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
  const courseSem = course ? String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';

  // If lock is semester-specific, course must match that semester
  if (courseSem && lockSem && lockSem !== 'all' && lockSem !== courseSem) {
    return false;
  }

  const normLabel = (lock.label || '').toUpperCase().trim();
  const commonCodes = ['AEC1', 'AEC2', 'MDC1', 'AEC3', 'AEC4', 'MDC-2', 'MDC2', 'VAC1', 'MDC3', 'VAC2', 'SEC', 'VAC3'];

  // If the label is NOT one of the specific common subjects (i.e. 'Other' or custom activity label),
  // then the whole section corresponding to this semester is locked!
  if (!commonCodes.includes(normLabel)) {
    return true;
  }

  // If label IS a common subject (e.g. MDC, AEC, VAC, SEC):
  // 1. Direct match with this course:
  if (course && courseMatchesCommonSubject(course, normLabel, commonBatches)) {
    return true;
  }

  // 2. Check if the department offers ANY course matching this common subject for this semester:
  const dept = (course && course.department) || (state.currentUser && state.currentUser.departmentName) || '';
  const deptCoursesForSem = (state.courses || []).filter(c => {
    const cDept = (c.department || '').toUpperCase().trim();
    const scSem = String(c.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    const matchesDept = !dept || cDept === dept.toUpperCase().trim();
    const matchesSem = (!lockSem || lockSem === 'all') || scSem === lockSem;
    return matchesDept && matchesSem;
  });

  const hasMatchingCourseInDept = deptCoursesForSem.some(c => 
    courseMatchesCommonSubject(c, normLabel, commonBatches)
  );

  if (hasMatchingCourseInDept) {
    // Department HAS a matching course for this common subject, so other major courses are NOT locked
    return false;
  }

  // If the department does NOT offer any course for this common subject in this semester:
  // Place the corresponding section lock on all courses of this semester, just like "Other"!
  return true;
}

// Renders the interactive contents of a grid cell
function renderCellSlot(baseCode, courseT, courseP, day, period, classIndex = null) {
  // Check if period is flagged by Admin for this course's semester & subject
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const currentCourse = courseT || courseP || (state.courses && state.courses.find(c => c.code === baseCode));
  const courseSem = String((courseT && courseT.semester) || (courseP && courseP.semester) || (currentCourse && currentCourse.semester) || '').replace(/^Sem(ester)?\s*/i, '').trim();
  const courseSemNum = parseInt(courseSem.replace(/\D+/g, ''), 10) || 0;
  
  const matchingLocks = globalLocks.filter(l => 
    isPeriodLockedForCourse(l, currentCourse, day, period, state.commonBatches || [])
  );
  // Prefer specific semester match over 'all'
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem.toLowerCase();
  }) || matchingLocks[0];

  const recT = (courseT && courseT.recommendations && courseT.recommendations[day] && courseT.recommendations[day][period]) || '';
  const recP = (courseP && courseP.recommendations && courseP.recommendations[day] && courseP.recommendations[day][period]) || '';
  
  const isM = (courseT && courseT.courseType === 'M') || (courseP && courseP.courseType === 'M');
  
  // Non-recommended slots are only locked in the first 4 semesters (Sem 1 - 4). Sem 5+ are open.
  let highlightClass = courseSemNum >= 5 ? '' : 'slot-recommend-none';
  let slotLabel = '';
  
  // Calculate keys for lookup based on class index if provided
  let courseTCode = courseT ? courseT.code : '';
  let coursePCode = courseP ? courseP.code : '';
  if (classIndex) {
    courseTCode = courseT ? `${baseCode}_C${classIndex}-T` : '';
    coursePCode = courseP ? `${baseCode}_C${classIndex}-P` : '';
  }
  
  let activeCourseCode = courseTCode || coursePCode;

  if (recT === 'B' || recP === 'B') {
    highlightClass = 'slot-recommend-blocked';
    slotLabel = 'Blocked';
    activeCourseCode = courseTCode || coursePCode;
  } else if (isM) {
    highlightClass = 'slot-recommend-m';
    slotLabel = '';
  } else if (recT === 'T') {
    highlightClass = 'slot-recommend-t';
    slotLabel = 'Theory Rec';
    activeCourseCode = courseTCode;
  } else if (recP === 'P') {
    highlightClass = 'slot-recommend-p';
    slotLabel = 'Practical Rec';
    activeCourseCode = coursePCode;
  } else if (recT === 'P') {
    highlightClass = 'slot-recommend-p';
    slotLabel = 'Practical Rec';
    activeCourseCode = courseTCode;
  } else if (recP === 'T') {
    highlightClass = 'slot-recommend-t';
    slotLabel = 'Theory Rec';
    activeCourseCode = coursePCode;
  } else {
    activeCourseCode = courseTCode || coursePCode;
    highlightClass = courseSemNum >= 5 ? '' : 'slot-recommend-none';
  }

  // Load active assigned codes for this slot (merging allocations from both suffixes if any)
  const assignedT = (courseTCode && state.allocations[courseTCode] && state.allocations[courseTCode][day] && state.allocations[courseTCode][day][period]) || [];
  const assignedP = (coursePCode && state.allocations[coursePCode] && state.allocations[coursePCode][day] && state.allocations[coursePCode][day][period]) || [];
  const mergedAssigned = Array.from(new Set([...assignedT, ...assignedP]));

  // Render assigned pills with dark red crosses and tooltips
  let pillsHtml = '';
  const locked = isTimetableLocked();
  mergedAssigned.forEach(facCode => {
    const facObj = state.faculty.find(f => f.code === facCode);
    const fullName = facObj ? facObj.name : facCode;
    
    let targetCode = activeCourseCode;
    if (courseTCode && assignedT.includes(facCode)) targetCode = courseTCode;
    else if (coursePCode && assignedP.includes(facCode)) targetCode = coursePCode;

    const crossIcon = locked ? '' : `<i class="fa-solid fa-xmark" onclick="event.stopPropagation(); unassignFaculty('${targetCode}', '${day}', '${period}', '${facCode}')"></i>`;

    pillsHtml += `
      <span class="fac-pill" title="Faculty Name: ${fullName}">
        ${facCode}
        ${crossIcon}
      </span>
    `;
  });

  let classes = `slot-interactive ${highlightClass}`;
  if (mergedAssigned.length > 0) {
    classes += ' slot-has-assignments';
  }
  let lockFlagBadge = '';
  if (globalLock) {
    classes += ' slot-admin-flagged';
    
    const currentDeptUpper = ((currentCourse && currentCourse.department) || (state.currentUser && state.currentUser.departmentName) || '').trim().toUpperCase();
    const lockLabelNorm = (globalLock.label || '').trim().toUpperCase();
    const lockClean = lockLabelNorm.replace(/[^A-Z0-9]/g, '');

    const matchingDeptBatches = (state.commonBatches || []).filter(b => {
      const bSubj = (b.subjectCode || '').trim().toUpperCase();
      const bClean = bSubj.replace(/[^A-Z0-9]/g, '');
      const matchSubj = (bSubj === lockLabelNorm) || (bClean && bClean === lockClean) || (bSubj && lockLabelNorm.includes(bSubj)) || (lockLabelNorm && bSubj.includes(lockLabelNorm));
      const matchSem = (!globalLock.semester || globalLock.semester === 'all' || String(globalLock.semester) === String(b.semester)) &&
                       (!courseSem || String(courseSem) === String(b.semester));
      if (!matchSubj || !matchSem) return false;

      const bDepts = Array.isArray(b.departments) && b.departments.length > 0
        ? b.departments.map(d => String(d).trim().toUpperCase())
        : [(b.department || '').trim().toUpperCase()];
      const isOffering = (b.department || '').trim().toUpperCase() === currentDeptUpper;
      const isParticipating = bDepts.includes(currentDeptUpper);
      return isOffering || isParticipating;
    });

    if (matchingDeptBatches.length > 0) {
      const batchesCards = matchingDeptBatches.map(b => {
        const isExternal = (b.department || '').trim().toUpperCase() !== currentDeptUpper;
        const offeringNotice = isExternal && b.department ? `<div style="font-size: 8px; color: #0284c7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;"><i class="fa-solid fa-school" style="font-size: 7px;"></i> From ${escapeHtml(b.department)}</div>` : '';
        return `
          <div class="common-batch-slot-card" style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 4px; padding: 2px 4px; margin-top: 2px; text-align: left; font-size: 9.5px; line-height: 1.25;" title="Batch: ${escapeHtml(b.batchName)} | Course: ${escapeHtml(b.courseCode || '')}${b.courseName ? ' - ' + escapeHtml(b.courseName) : ''} | Faculty: ${escapeHtml(b.teacherName || b.teacherCode || '')}">
            <div style="font-weight: 700; color: #1d4ed8; display: flex; align-items: center; justify-content: space-between; gap: 2px;">
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 72%;"><i class="fa-solid fa-users-rectangle" style="font-size: 8px;"></i> ${escapeHtml(b.batchName)}</span>
              <span style="font-size: 8px; background: #dbeafe; color: #1e40af; padding: 0 3px; border-radius: 2px; font-weight: 600;">${escapeHtml(b.courseCode || b.subjectCode || '')}</span>
            </div>
            <div style="color: #1e3a8a; font-size: 8.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              <i class="fa-solid fa-chalkboard-user" style="font-size: 7.5px;"></i> ${escapeHtml(b.teacherName || b.teacherCode || 'TBD')}
            </div>
            ${offeringNotice}
          </div>
        `;
      }).join('');

      lockFlagBadge = `
        <div class="admin-lock-tag" title="Common Activity: ${globalLock.label || 'Locked Period'}" style="font-size: 9px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; display: flex; align-items: center; justify-content: space-between;">
          <span><i class="fa-solid fa-lock" style="font-size: 8px;"></i> ${globalLock.label}</span>
          <span style="font-size: 8px; background: #fde68a; padding: 0 3px; border-radius: 2px;">${matchingDeptBatches.length} Batch${matchingDeptBatches.length === 1 ? '' : 'es'}</span>
        </div>
        ${batchesCards}
      `;
    } else {
      lockFlagBadge = `
        <div class="admin-lock-tag" title="Admin Flag: ${globalLock.label || 'Locked Period'}" style="font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
          <i class="fa-solid fa-lock" style="font-size: 9px;"></i> ${globalLock.label || 'Admin Flag'}
        </div>
      `;
    }
  }
  
  const html = `
    <div class="cell-slot" onclick="activateSlot(this, '${baseCode}', '${activeCourseCode}', '${day}', '${period}')">
      ${lockFlagBadge}
      <div class="cell-info text-sm bold text-muted">${slotLabel}</div>
      <div class="cell-assigned-box">
        ${pillsHtml}
      </div>
    </div>
  `;

  return { classes, html };
}

window.activateSlot = function(cellContainer, baseCode, activeCourseCode, day, period) {
  if (isTimetableLocked()) {
    const deptName = state.currentUser ? state.currentUser.departmentName : '';
    const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
    showModalAlert(
      'Timetable Locked',
      `Your timetable is currently ${deptInfo.status}. You cannot make any changes to allocations unless you revert the submission or ask the Admin to unlock it.`,
      'info'
    );
    return;
  }

  const cell = cellContainer.closest('td');
  
  const openSelector = () => {
    cell.classList.add('slot-active');
    openFacultySelectModal(baseCode, activeCourseCode, day, period, cell);
  };

  // Check if period is flagged by Admin
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const course = state.courses.find(c => c.code === activeCourseCode) || state.courses.find(c => c.code === baseCode);
  const courseSem = course ? String(course.semester).replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';
  const courseSemNum = course ? (parseInt(String(course.semester).replace(/\D+/g, ''), 10) || 0) : 0;
  
  const matchingLocks = globalLocks.filter(l => 
    isPeriodLockedForCourse(l, course, day, period, state.commonBatches || [])
  );
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem;
  }) || matchingLocks[0];

  if (globalLock) {
    openLockedPeriodDetailsModal(day, period, courseSem, globalLock, openSelector);
    return;
  }

  // Blocked slot confirmation
  if (cell.classList.contains('slot-recommend-blocked')) {
    if (!cell.classList.contains('slot-active')) {
      showModalConfirm(
        'Unlock Blocked Slot?',
        'This period is marked as BLOCKED for this course in Curriculum Slot Allocation. Are you sure you want to unlock it to assign faculty?',
        () => {
          openSelector();
        }
      );
      return;
    }
  }

  // Unrecommended slot lock only exists in the first 4 semesters (Sem 1 - 4)
  if (cell.classList.contains('slot-recommend-none') && courseSemNum < 5) {
    if (!cell.classList.contains('slot-active')) {
      showModalConfirm(
        'Unlock Slot?', 
        'This is a non-recommended timetable slot. Are you sure you want to unlock it for allocation?', 
        () => {
          openSelector();
        }
      );
      return;
    }
  }
  openSelector();
};

// Global active slot context
let activeSlotContext = null;

window.openFacultySelectModal = function(baseCode, courseCode, day, period, cellElement) {
  activeSlotContext = { baseCode, courseCode, day, period, cell: cellElement };
  
  const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/_C\d+/, '');
  const course = (state.courses || []).find(c => c.code === courseCode) || (state.courses || []).find(c => c.code === baseCode) || (state.courses || []).find(c => c.code === baseCodeForRec);
  const classNumMatch = (courseCode || baseCode).match(/(_G|_C)(\d+)/);
  const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (course ? (course.class || course.group || 0) : 0);
  const mappedBatches = course ? course.mappedBatches : [];
  const cleanBase = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const formattedCode = formatCourseCodeWithGroup(cleanBase, classNum, mappedBatches);
  
  const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCode] || localSubjectMappings[baseCodeForRec] || {};
  const isPrac = (mData.courseType === 'P' || (course && course.courseType === 'P') || courseCode.endsWith('-P') || ((course && course.recommendations && course.recommendations[day] && course.recommendations[day][period]) === 'P'));
  const typeText = isPrac ? 'Practical' : 'Theory';

  const pracTeachers = (mData.practicalTeachers && mData.practicalTeachers.length > 0)
    ? mData.practicalTeachers
    : ((course && course.practicalTeachers && course.practicalTeachers.length > 0) ? course.practicalTeachers : []);

  let detailsHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
      <div>Course: <strong>${formattedCode}</strong> <span class="badge ${isPrac ? 'badge-success' : 'badge-warning'}">${typeText}</span> | Day: <strong>${day}</strong> | Period: <strong>${period}</strong></div>
      ${(isPrac && pracTeachers.length > 1) ? `
        <button type="button" class="btn btn-success btn-xs" onclick="assignAllPracticalCoTeachers('${courseCode}', '${day}', '${period}')" style="font-weight: 700; padding: 3px 8px;">
          <i class="fa-solid fa-users"></i> Assign All Co-Teachers (${pracTeachers.join(' + ')})
        </button>
      ` : ''}
    </div>
  `;
  document.getElementById('fac-select-details').innerHTML = detailsHtml;
  
  // Reset search input
  const searchInput = document.getElementById('fac-search-input');
  searchInput.value = '';
  
  // Populate the list
  renderFacultySelectList();
  
  // Show modal
  document.getElementById('modal-faculty-select').classList.remove('hidden');
};

window.assignAllPracticalCoTeachers = async function(courseCode, day, period) {
  const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/_C\d+/, '');
  const course = state.courses.find(c => c.code === courseCode) || state.courses.find(c => c.code === baseCodeForRec);
  const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCodeForRec] || {};
  const pracTeachers = (mData.practicalTeachers && mData.practicalTeachers.length > 0)
    ? mData.practicalTeachers
    : ((course && course.practicalTeachers && course.practicalTeachers.length > 0) ? course.practicalTeachers : []);
  if (pracTeachers.length === 0) return;

  const deptName = state.currentUser.departmentName;
  for (const facCode of pracTeachers) {
    const res = await authFetch(`${API_BASE}/allocations/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        courseCode,
        weekday: day,
        period,
        facultyCodes: [facCode]
      })
    });
    const validation = await res.json();
    if (!validation.valid) {
      showModalAlert('Booking Conflict', `Faculty '${facCode}' is already allocated elsewhere during ${day} Period ${period}.`, 'danger');
      return;
    }
  }

  if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
  if (!state.allocations[courseCode][day]) state.allocations[courseCode][day] = {};
  state.allocations[courseCode][day][period] = Array.from(new Set([...pracTeachers]));

  // Auto-fill other practical recommended slots if toggle is ON
  const toggleAutofill = document.getElementById('toggle-autofill-recommended');
  const isAutofillOn = !!(toggleAutofill && toggleAutofill.checked);

  const courseSem = course ? String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';
  const courseSemNum = course ? (parseInt(String(course.semester || '').replace(/\D+/g, ''), 10) || 0) : 0;

  const recCourse = (course && course.recommendations && Object.keys(course.recommendations).length > 0)
    ? course
    : (state.courses.find(c => c.code === baseCodeForRec) || course);

  const recs = recCourse ? (
    (recCourse.recommendations && Object.keys(recCourse.recommendations).length > 0)
      ? recCourse.recommendations
      : (recCourse.masterRecommendations || {})
  ) : {};

  const clickedSlotRec = (recs[day] && recs[day][period]) || '';
  const isClickedSlotRecommended = (clickedSlotRec === 'P');

  // Auto-fill ONLY runs if:
  // 1. Toggle is ON
  // 2. The course belongs to Sem 1 - 4 (disabled for open/unconstrained sections like Sem 5+)
  // 3. The user clicked on an actual recommended practical slot ('P'). Clicking an unrecommended slot will NOT auto-fill!
  if (isAutofillOn && course && courseSemNum < 5 && isClickedSlotRecommended) {
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

    weekdays.forEach(d => {
      const dayRecs = recs[d] || {};
      Object.keys(dayRecs).forEach(p => {
        if (dayRecs[p] === 'P') {
          if (d === day && String(p) === String(period)) return;

          pracTeachers.forEach(fc => {
            const unavailList = (state.teacherUnavailability && state.teacherUnavailability[fc]) || [];
            const isUnavail = unavailList.some(u => u.day.toUpperCase() === d.toUpperCase() && (u.period === 'all' || String(u.period) === String(p)));
            const hasClash = checkLocalClash(fc, d, p, courseCode);

            if (!hasClash && !isUnavail) {
              if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
              if (!state.allocations[courseCode][d]) state.allocations[courseCode][d] = {};
              if (!state.allocations[courseCode][d][p]) state.allocations[courseCode][d][p] = [];

              if (!state.allocations[courseCode][d][p].includes(fc)) {
                state.allocations[courseCode][d][p].push(fc);
              }
            }
          });
        }
      });
    });
  }

  renderFacultySelectList();
  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  triggerAutosave();
};

function renderFacultySelectList() {
  if (!activeSlotContext) return;
  const { courseCode, day, period } = activeSlotContext;
  
  const tbody = document.querySelector('#table-fac-select-list tbody');
  tbody.innerHTML = '';
  
  const deptName = state.currentUser.departmentName;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  
  // Get active assignments
  const baseCode = courseCode.replace(/-(T|P)$/, '');
  const courseTCode = `${baseCode}-T`;
  const coursePCode = `${baseCode}-P`;
  
  const assignedT = (state.allocations[courseTCode] && state.allocations[courseTCode][day] && state.allocations[courseTCode][day][period]) || [];
  const assignedP = (state.allocations[coursePCode] && state.allocations[coursePCode][day] && state.allocations[coursePCode][day][period]) || [];
  const assignedDirect = (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) || [];
  const mergedAssigned = Array.from(new Set([...assignedT, ...assignedP, ...assignedDirect]));
  
  deptFaculty.forEach(f => {
    const isAssigned = mergedAssigned.includes(f.code);
    const unavailList = (state.teacherUnavailability && state.teacherUnavailability[f.code]) || [];
    const isUnavail = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(period)));

    const tr = document.createElement('tr');
    
    // Check which actual course holds this allocation (T or P)
    let assignedCourseCode = courseCode;
    if (isAssigned) {
      if (assignedDirect.includes(f.code)) assignedCourseCode = courseCode;
      else if (assignedT.includes(f.code)) assignedCourseCode = courseTCode;
      else if (assignedP.includes(f.code)) assignedCourseCode = coursePCode;
    }
    
    let actionBtn = '';
    if (isAssigned) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" onclick="unassignFacultyFromModal('${assignedCourseCode}', '${f.code}')"><i class="fa-solid fa-user-minus"></i> Remove</button>`;
    } else if (isUnavail) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" disabled title="Faculty member marked this slot off as unavailable"><i class="fa-solid fa-ban"></i> Unavailable</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-xs" onclick="assignFacultyFromModal('${courseCode}', '${f.code}')"><i class="fa-solid fa-user-plus"></i> Assign</button>`;
    }

    tr.innerHTML = `
      <td style="text-align: center;"><span class="fac-pill">${f.code}</span></td>
      <td>
        <strong>${f.name}</strong>
        ${isUnavail ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 10px; margin-left: 6px;"><i class="fa-solid fa-calendar-xmark"></i> Blackout Slot</span>` : ''}
      </td>
      <td style="text-align: center;">
        ${actionBtn}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.assignFacultyFromModal = async function(courseCode, facultyCode) {
  if (!activeSlotContext) return;
  const { day, period } = activeSlotContext;
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/allocations/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        courseCode,
        weekday: day,
        period,
        facultyCodes: [facultyCode]
      })
    });
    const validation = await res.json();
    
    if (!validation.valid) {
      const conf = validation.conflicts[0];
      const clashingCourse = state.courses.find(c => c.code === conf.clashingCourseCode);
      const clashingClassNum = (clashingCourse && (clashingCourse.class || clashingCourse.group)) || (conf.clashingCourseCode.match(/(_G|_C)(\d+)/) ? conf.clashingCourseCode.match(/(_G|_C)(\d+)/)[2] : null);
      const clashingGroupSuffix = clashingClassNum ? ` (Class C${clashingClassNum})` : '';
      showModalAlert(
        'Hard Booking Clash!', 
        `Double-booking violation!\n\nFaculty member '${conf.facultyName}' (${conf.facultyCode}) is already allocated to '${conf.clashingCourseName}' (${conf.clashingCourseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '')}${clashingGroupSuffix}) on ${day} Period ${period} in department ${conf.department}.`,
        'danger'
      );
      return;
    }
    
    // Save locally
    if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
    if (!state.allocations[courseCode][day]) state.allocations[courseCode][day] = {};
    if (!state.allocations[courseCode][day][period]) state.allocations[courseCode][day][period] = [];
    
    if (!state.allocations[courseCode][day][period].includes(facultyCode)) {
      state.allocations[courseCode][day][period].push(facultyCode);
    }
    
    const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const course = state.courses.find(c => c.code === courseCode) || state.courses.find(c => c.code === baseCodeForRec);
    const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCodeForRec] || {};
    const isPrac = (mData.courseType === 'P' || (course && course.courseType === 'P') || courseCode.endsWith('-P') || ((course && course.recommendations && course.recommendations[day] && course.recommendations[day][period]) === 'P'));

    // Check if auto-fill recommended toggle is ON
    const toggleAutofill = document.getElementById('toggle-autofill-recommended');
    const isAutofillOn = !!(toggleAutofill && toggleAutofill.checked);

    const courseSem = course ? String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';
    const courseSemNum = course ? (parseInt(String(course.semester || '').replace(/\D+/g, ''), 10) || 0) : 0;

    const recCourse = (course && course.recommendations && Object.keys(course.recommendations).length > 0)
      ? course
      : (state.courses.find(c => c.code === baseCodeForRec) || course);

    const recs = recCourse ? (
      (recCourse.recommendations && Object.keys(recCourse.recommendations).length > 0)
        ? recCourse.recommendations
        : (recCourse.masterRecommendations || {})
    ) : {};
    
    const clickedSlotRec = (recs[day] && recs[day][period]) || '';
    const isClickedSlotRecommended = (clickedSlotRec === 'T' || clickedSlotRec === 'P');

    // Auto-fill ONLY runs if:
    // 1. Toggle is ON
    // 2. The course belongs to Sem 1 - 4 (disabled for open/unconstrained sections like Sem 5+)
    // 3. The user clicked on an actual recommended slot ('T' or 'P'). Clicking an unrecommended slot will NOT auto-fill!
    if (isAutofillOn && course && courseSemNum < 5 && isClickedSlotRecommended) {
      const targetType = clickedSlotRec;
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

      weekdays.forEach(d => {
        const dayRecs = recs[d] || {};
        Object.keys(dayRecs).forEach(p => {
          if (dayRecs[p] === targetType) {
            // Skip the current period which was already assigned
            if (d === day && String(p) === String(period)) return;

            // Check if teacher has an unavailability or clash in department
            const unavailList = (state.teacherUnavailability && state.teacherUnavailability[facultyCode]) || [];
            const isUnavail = unavailList.some(u => u.day.toUpperCase() === d.toUpperCase() && (u.period === 'all' || String(u.period) === String(p)));
            const hasClash = checkLocalClash(facultyCode, d, p, courseCode);

            if (!hasClash && !isUnavail) {
              if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
              if (!state.allocations[courseCode][d]) state.allocations[courseCode][d] = {};
              if (!state.allocations[courseCode][d][p]) state.allocations[courseCode][d][p] = [];

              if (!state.allocations[courseCode][d][p].includes(facultyCode)) {
                state.allocations[courseCode][d][p].push(facultyCode);
              }
            }
          }
        });
      });
    }

    // For practical slots: keep modal open so helpers can be assigned to the same period, with real-time update
    if (isPrac) {
      renderFacultySelectList();
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      triggerAutosave();
    } else {
      // Close faculty selector modal for single-teacher theory slots
      document.getElementById('modal-faculty-select').classList.add('hidden');
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      activeSlotContext = null;
      triggerAutosave();
    }
  } catch (err) {
    console.error(err);
  }
};

window.unassignFacultyFromModal = function(courseCode, facultyCode) {
  if (!activeSlotContext) return;
  const { day, period } = activeSlotContext;
  
  if (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) {
    state.allocations[courseCode][day][period] = state.allocations[courseCode][day][period].filter(code => code !== facultyCode);
    renderFacultySelectList(); // refresh list in modal
    renderAllocationMatrix(); // refresh grid
    updateDeptLiveWorkloadTracker(); // refresh workload
    triggerAutosave();
  }
};

window.unassignFaculty = function(courseCode, day, period, facultyCode) {
  if (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) {
    state.allocations[courseCode][day][period] = state.allocations[courseCode][day][period].filter(code => code !== facultyCode);
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
    triggerAutosave();
  }
};

// Auto fill logic
let autoFillContext = null;
function showAutoFillPrompt(courseCode, type, facultyCode) {
  autoFillContext = { courseCode, type, facultyCode };
  const typeText = type === 'T' ? 'theory' : 'practical';
  document.getElementById('autofill-slot-type').textContent = typeText;
  document.getElementById('dialog-autofill').classList.remove('hidden');
}

document.getElementById('btn-autofill-all').addEventListener('click', () => {
  if (autoFillContext) {
    const { courseCode, type, facultyCode } = autoFillContext;
    const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/_C\d+/, '');
    const course = state.courses.find(c => c.code === courseCode)
               || state.courses.find(c => c.code === baseCodeForRec);
    const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCodeForRec] || {};
    const teachersToAssign = (type === 'P' && mData.practicalTeachers && mData.practicalTeachers.length > 0)
      ? mData.practicalTeachers
      : ((type === 'P' && course && course.practicalTeachers && course.practicalTeachers.length > 0)
          ? course.practicalTeachers
          : [facultyCode]);
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    
    if (course) {
      weekdays.forEach(d => {
        const recs = course.recommendations[d] || {};
        Object.keys(recs).forEach(p => {
          if (recs[p] === type) {
            if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
            if (!state.allocations[courseCode][d]) state.allocations[courseCode][d] = {};
            if (!state.allocations[courseCode][d][p]) state.allocations[courseCode][d][p] = [];
            
            teachersToAssign.forEach(fc => {
              const hasClash = checkLocalClash(fc, d, p, courseCode);
              if (!hasClash && !state.allocations[courseCode][d][p].includes(fc)) {
                state.allocations[courseCode][d][p].push(fc);
              }
            });
          }
        });
      });
    }
  }
  closeAutoFill();
});

document.getElementById('btn-autofill-single').addEventListener('click', () => {
  closeAutoFill();
});

function closeAutoFill() {
  document.getElementById('dialog-autofill').classList.add('hidden');
  autoFillContext = null;
  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  triggerAutosave();
}

function checkLocalClash(facultyCode, day, period, excludeCourseCode) {
  for (const courseCode of Object.keys(state.allocations)) {
    if (courseCode === excludeCourseCode) continue;
    const days = state.allocations[courseCode];
    if (days[day] && days[day][period] && days[day][period].includes(facultyCode)) {
      return true;
    }
  }
  return false;
}

// Live Workload count
function updateDeptLiveWorkloadTracker() {
  const deptName = state.currentUser.departmentName;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const container = document.getElementById('dept-live-workload');
  container.innerHTML = '';

  deptFaculty.forEach(f => {
    let hours = 0;
    Object.keys(state.allocations).forEach(courseCode => {
      const days = state.allocations[courseCode];
      Object.keys(days).forEach(day => {
        Object.keys(days[day]).forEach(p => {
          if (days[day][p] && days[day][p].includes(f.code)) hours++;
        });
      });
    });

    container.innerHTML += `
      <div class="workload-pill">
        <span class="fac-code">${f.code}</span>
        <span class="fac-hours">${hours} hrs</span>
      </div>
    `;
  });
}

// Save or submit allocations
async function saveDepartmentAllocations(isSubmission = false) {
  const deptName = state.currentUser.departmentName;
  
  if (isSubmission) {
    // Missing allocations warnings check
    const missing = [];
    const deptCourses = state.courses.filter(c => c.department === deptName);
    
    deptCourses.forEach(course => {
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
      weekdays.forEach(day => {
        const recs = course.recommendations[day] || {};
        Object.keys(recs).forEach(p => {
          const alloc = (state.allocations[course.code] && state.allocations[course.code][day] && state.allocations[course.code][day][p]) || [];
          if (alloc.length === 0) {
            const cleanCode = course.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
            const classNumMatch = course.code.match(/(_G|_C)(\d+)/);
            const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (course.class || course.group || 0);
            const classText = classNum > 0 ? ` (Class C${classNum})` : '';
            const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
            missing.push(`${cleanCode}${classText} alias '${alias}' requires allocation on ${day} Period ${p}`);
          }
        });
      });
    });

    if (missing.length > 0) {
      showModalConfirm(
        'Missing Recommended Slots', 
        `Some recommended slots are missing allocations:\n\n${missing.slice(0, 4).join('\n')}\n${missing.length > 4 ? '... and ' + (missing.length - 4) + ' more' : ''}\n\nDo you want to proceed with submission?`,
        () => executeSave(isSubmission)
      );
      return;
    }
  }

  executeSave(isSubmission);
}

async function executeSave(isSubmission) {
  const deptName = state.currentUser.departmentName;
  try {
    const saveRes = await authFetch(`${API_BASE}/allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        allocations: state.allocations
      })
    });
    const result = await saveRes.json();
    
    if (!saveRes.ok) {
      showModalAlert('Clash Error', 'Save aborted: ' + result.message, 'danger');
      return;
    }

    if (isSubmission) {
      const subRes = await authFetch(`${API_BASE}/submissions/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          status: 'Submitted',
          comments: 'Timetable submitted by department coordinator.'
        })
      });
      if (subRes.ok) {
        showModalAlert('Timetable Submitted', 'Your timetable schedule has been submitted for Admin approval.', 'success');
        await loadDepartmentWorkspace();
      }
    } else {
      showModalAlert('Draft Saved', 'Your draft changes have been successfully saved on the server.', 'success');
    }
  } catch (err) {
    console.error(err);
  }
}

// -------------------------------------------------------------
// Inline Editors (Shuffled from Admin Panel to Department View)
// -------------------------------------------------------------
function renderDeptDataEditors() {
  const deptName = state.currentUser.departmentName;
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const locked = isTimetableLocked();

  document.getElementById('count-dept-courses').textContent = deptCourses.length;
  document.getElementById('count-dept-faculty').textContent = deptFaculty.length;

  // Render Courses Edit list
  const coursesTbody = document.querySelector('#table-dept-courses tbody');
  coursesTbody.innerHTML = '';
  deptCourses.forEach(c => {
    const mapped = getCourseClassBatches(c);
    const batchListHtml = mapped.length > 0 
      ? mapped.map(b => `<span class="badge badge-info" style="font-size: 11px; margin-right: 4px;">${b}</span>`).join('')
      : `<span class="text-muted text-sm">None</span>`;

    const tr = document.createElement('tr');
    // For tooltip and visual code formatting, fetch appropriate batches list
    const mappedBaseBatches = getCourseClassBatches(c);
    const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
    const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 0);
    const cleanCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const formattedCode = formatCourseCodeWithGroup(cleanCode, classNum, mappedBaseBatches);
    tr.innerHTML = `
      <td><strong>${formattedCode}</strong></td>
      <td>${c.semester}</td>
      <td>${c.category}</td>
      <td>
        <span class="text-sm font-medium">${c.name}</span>
      </td>
      <td>
        <input type="text" class="form-control text-sm" id="calias-${c.code}" value="${c.alias || ''}" ${locked ? 'disabled' : ''}>
      </td>
      <td>
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; max-width: 250px;">
          <div style="display:flex; flex-wrap:wrap; gap:4px; flex:1;">${batchListHtml}</div>
          <button class="btn btn-outline btn-xs" style="padding: 2px 6px; font-size:10px; margin-left: auto;" onclick="openDeptBatchMappingModal('${c.code}')" ${locked ? 'disabled' : ''} title="Configure Classes & Batches">
            <i class="fa-solid fa-layer-group"></i> Classes
          </button>
        </div>
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveDeptCourseRecord('${c.code}')" ${locked ? 'disabled' : ''}><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    coursesTbody.appendChild(tr);
  });

  // Render Faculty Edit list
  const facultyTbody = document.querySelector('#table-dept-faculty tbody');
  facultyTbody.innerHTML = '';
  deptFaculty.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${f.staffId}</td>
      <td><strong>${f.name}</strong></td>
      <td>
        <input type="text" class="form-control text-sm" id="fcode-${f.staffId}" value="${f.code}" style="max-width:120px;" ${locked ? 'disabled' : ''}>
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveDeptFacultyCode('${f.staffId}')" ${locked ? 'disabled' : ''}><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    facultyTbody.appendChild(tr);
  });

  // Setup click warning handler on details tab when locked
  const tableCourses = document.getElementById('table-dept-courses');
  if (tableCourses) {
    tableCourses.onclick = (e) => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert(
          'Timetable Locked',
          `Your timetable is currently ${deptInfo.status}. You cannot edit course aliases or map batches unless you revert the submission or ask the Admin to unlock it.`,
          'info'
        );
      }
    };
  }
  const tableFaculty = document.getElementById('table-dept-faculty');
  if (tableFaculty) {
    tableFaculty.onclick = (e) => {
      if (isTimetableLocked()) {
        const deptName = state.currentUser ? state.currentUser.departmentName : '';
        const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
        showModalAlert(
          'Timetable Locked',
          `Your timetable is currently ${deptInfo.status}. You cannot edit faculty visual initials codes unless you revert the submission or ask the Admin to unlock it.`,
          'info'
        );
      }
    };
  }
}

window.saveDeptCourseRecord = async function(code) {
  const alias = document.getElementById(`calias-${code}`).value.trim();
  const course = state.courses.find(c => c.code === code);
  const name = course ? course.name : '';
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/courses/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, alias, departmentName: deptName })
    });
    if (res.ok) {
      showModalAlert('Success', 'Course details updated successfully!', 'success');
      await fetchGlobalData();
      renderAllocationMatrix();
      renderDeptDataEditors();
    } else {
      const err = await res.json();
      showModalAlert('Error', err.message, 'danger');
      renderDeptDataEditors();
    }
  } catch (err) {
    console.error(err);
    renderDeptDataEditors();
  }
};

window.saveDeptFacultyCode = async function(staffId) {
  const code = document.getElementById(`fcode-${staffId}`).value.trim();
  const deptName = state.currentUser.departmentName;
  
  try {
    const res = await authFetch(`${API_BASE}/faculty/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, code, departmentName: deptName })
    });
    if (res.ok) {
      showModalAlert('Success', 'Faculty initials code updated.', 'success');
      await fetchGlobalData();
      await loadDepartmentWorkspace();
    } else {
      const err = await res.json();
      let explanation = err.message || 'Faculty code update failed.';
      if (explanation.includes('already assigned')) {
        explanation += '\n\nNote: Faculty visual initials codes must be unique across the entire college to prevent scheduling overlaps and distinguish between faculty members during allocation.';
      }
      showModalAlert('Conflict Error', explanation, 'danger');
      renderDeptDataEditors();
    }
  } catch (err) {
    console.error(err);
    renderDeptDataEditors();
  }
};

// -------------------------------------------------------------
// Teacher Availability / Blackout Days Editor
// -------------------------------------------------------------
let activeUnavailTeacherCode = '';
let localTeacherUnavail = [];

function renderTeacherAvailabilityEditor() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const select = document.getElementById('select-avail-teacher');
  if (!select) return;

  if (deptFaculty.length === 0) {
    select.innerHTML = '<option value="">No faculty found in department</option>';
    return;
  }

  const currentVal = select.value;
  select.innerHTML = '';
  deptFaculty.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.code;
    opt.textContent = `${f.code} - ${f.name}`;
    select.appendChild(opt);
  });

  if (currentVal && deptFaculty.some(f => f.code === currentVal)) {
    select.value = currentVal;
  } else {
    select.value = deptFaculty[0].code;
  }

  activeUnavailTeacherCode = select.value;
  const allUnavail = state.teacherUnavailability || {};
  localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
  updateTeacherUnavailSnapshot();
  loadTeacherUnavailMatrix();
}

function loadTeacherUnavailMatrix() {
  const table = document.getElementById('table-teacher-unavail-matrix');
  const countBadge = document.getElementById('teacher-unavail-status-badge');
  if (!table || !activeUnavailTeacherCode) return;

  const rawPeriods = (state.config && state.config.periods) || ['1', '2', '3', 'LB', '4', '5', '6'];
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  if (countBadge) {
    countBadge.textContent = `${localTeacherUnavail.length} Unavailable Period(s)`;
  }

  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  let headerHtml = '<tr><th style="width: 130px; text-align: center;">Weekday</th>';
  rawPeriods.forEach(p => {
    if (String(p).toUpperCase() === 'LB') {
      headerHtml += '<th style="width: 60px; background: var(--background); font-size: 11px; text-align: center;">LB</th>';
    } else {
      headerHtml += `<th style="text-align: center;">Period ${p}</th>`;
    }
  });
  headerHtml += '<th style="width: 130px; text-align: center;">Quick Action</th></tr>';
  thead.innerHTML = headerHtml;

  let bodyHtml = '';
  weekdays.forEach(day => {
    bodyHtml += `<tr><td style="font-weight: 700; text-align: center; background: var(--surface-1);">${day}</td>`;
    
    rawPeriods.forEach(p => {
      const pStr = String(p).trim();
      if (pStr.toUpperCase() === 'LB') {
        bodyHtml += '<td style="background: var(--background); color: var(--text-muted); font-size: 11px; text-align: center;">LB</td>';
      } else {
        const isOff = localTeacherUnavail.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === pStr));
        if (isOff) {
          // Entire box is solid red! No toggle icons!
          bodyHtml += `
            <td class="teacher-unavail-cell off" data-day="${day}" data-period="${pStr}" title="Click to mark Available">
              <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">UNAVAILABLE</span>
            </td>`;
        } else {
          // Available clean cell! No toggle icons!
          bodyHtml += `
            <td class="teacher-unavail-cell available" data-day="${day}" data-period="${pStr}" title="Click to mark Unavailable">
              <span style="font-size: 11px; font-weight: 500;">Available</span>
            </td>`;
        }
      }
    });

    // Quick Day Toggle button
    const realPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
    const dayOffCount = localTeacherUnavail.filter(u => u.day.toUpperCase() === day.toUpperCase()).length;
    const isDayFull = dayOffCount >= realPeriods.length;

    bodyHtml += `
      <td style="text-align: center;">
        <button type="button" class="btn btn-outline btn-xs btn-toggle-day-off" data-day="${day}" style="font-size: 11px; padding: 4px 10px; ${isDayFull ? 'background: #fee2e2; color: #dc2626; border-color: #fca5a5;' : ''}">
          ${isDayFull ? 'Clear Day' : 'Mark Day Off'}
        </button>
      </td>
    </tr>`;
  });
  tbody.innerHTML = bodyHtml;

  // Bind cell clicks to toggle availability
  table.querySelectorAll('.teacher-unavail-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.preventDefault();
      if (isTimetableLocked()) return;
      const day = cell.getAttribute('data-day');
      const period = cell.getAttribute('data-period');
      
      const idx = localTeacherUnavail.findIndex(u => u.day.toUpperCase() === day.toUpperCase() && String(u.period) === String(period));
      if (idx >= 0) {
        localTeacherUnavail.splice(idx, 1);
      } else {
        localTeacherUnavail.push({ day, period: String(period) });
      }
      loadTeacherUnavailMatrix();
    });
  });

  // Bind Day Toggle buttons
  table.querySelectorAll('.btn-toggle-day-off').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (isTimetableLocked()) return;
      const day = btn.getAttribute('data-day');
      const realPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
      const dayCount = localTeacherUnavail.filter(u => u.day.toUpperCase() === day.toUpperCase()).length;

      if (dayCount >= realPeriods.length) {
        // Clear all entries for this day
        localTeacherUnavail = localTeacherUnavail.filter(u => u.day.toUpperCase() !== day.toUpperCase());
      } else {
        // Mark all real periods of this day
        realPeriods.forEach(p => {
          if (!localTeacherUnavail.some(u => u.day.toUpperCase() === day.toUpperCase() && String(u.period) === String(p))) {
            localTeacherUnavail.push({ day, period: String(p) });
          }
        });
      }
      loadTeacherUnavailMatrix();
    });
  });
}


// -------------------------------------------------------------
// Print Preview timetime modal
// -------------------------------------------------------------
let activePrintDept = "";

function bindPrintEvents() {
  document.getElementById('btn-close-print-modal').addEventListener('click', () => {
    document.getElementById('modal-print-preview').classList.add('hidden');
  });
  
  document.getElementById('print-mode-select').addEventListener('change', () => {
    buildPrintTimetableHtml(document.getElementById('print-mode-select').value);
  });
  
  document.getElementById('btn-trigger-print').addEventListener('click', () => {
    window.print();
  });
  
  document.getElementById('btn-export-timetable-csv').addEventListener('click', () => {
    exportPrintTimetableToCSV();
  });
}

function bindFacultySelectEvents() {
  const modal = document.getElementById('modal-faculty-select');
  const btnClose = document.getElementById('btn-close-fac-select');
  const btnDone = document.getElementById('btn-done-fac-select');
  const searchInput = document.getElementById('fac-search-input');
  
  const closeModal = () => {
    modal.classList.add('hidden');
    if (activeSlotContext && activeSlotContext.cell) {
      activeSlotContext.cell.closest('td').classList.remove('slot-active');
    }
    activeSlotContext = null;
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnDone) btnDone.addEventListener('click', closeModal);
  
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = document.querySelectorAll('#table-fac-select-list tbody tr');
    rows.forEach(row => {
      const text = row.innerText.toLowerCase();
      row.style.display = text.includes(query) ? '' : 'none';
    });
  });
}


function openTimetablePrintPreview(deptName) {
  activePrintDept = deptName;
  document.getElementById('print-dept-name').textContent = `DEPARTMENT OF ${deptName}`;
  document.getElementById('print-active-sem').textContent = `${state.config.semesterType} SEMESTER`;
  document.getElementById('print-active-year').textContent = state.config.academicYear;
  
  buildPrintTimetableHtml('medium');
  document.getElementById('modal-print-preview').classList.remove('hidden');
}

function buildPrintTimetableHtml(displayMode) {
  const periods = state.config.periods;
  const table = document.getElementById('print-grid-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  thead.innerHTML = `
    <tr>
      <th style="width: 80px;">Day</th>
      <th style="width: 100px; text-align: left;">Class/Semester</th>
      ${periods.map(p => `<th>${p}</th>`).join('')}
    </tr>
  `;

  const deptCourses = state.courses.filter(c => c.department === activePrintDept);
  renderPrintGridRows(deptCourses, state.allocations, periods, displayMode, tbody);
}

function formatCategory(cat) {
  if (!cat) return "Major";
  const upper = cat.toUpperCase();
  if (["MDC", "SEC", "AEC", "VAC", "OEC", "VBC"].includes(upper)) {
    return upper;
  }
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

function getTimetableRowCategory(course) {
  const semLabel = state.config.semesterLabels[course.semester] || `${course.semester} Sem`;
  const catStr = formatCategory(course.category);
  
  if (semLabel.toUpperCase().includes('BSC') || semLabel.toUpperCase().includes('MSC')) {
    return `${semLabel} ${catStr}`;
  }
  
  const isPg = course.code.toUpperCase().includes('MSC') || 
               course.pathway.toUpperCase().includes('MSC') || 
               course.pathway.toUpperCase().includes('POST GRADUATE') ||
               course.programType === 'PG';
  const progLabel = isPg ? 'MSC' : 'BSC';
  return `${semLabel} ${progLabel} ${catStr}`;
}

function renderPrintGridRows(courses, allocations, periods, displayMode, tbody) {
  tbody.innerHTML = '';
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const weekdayShort = { "MONDAY": "MON", "TUESDAY": "TUES", "WEDNESDAY": "WED", "THURSDAY": "THUR", "FRIDAY": "FRI" };

  // Expand courses that have classes > 1 into virtual course objects!
  const expandedCourses = [];
  courses.forEach(c => {
    if (c.classes && c.classes > 1) {
      for (let cl = 1; cl <= c.classes; cl++) {
        const base = c.code.replace(/-(T|P)$/, '');
        const suffix = c.code.match(/-(T|P)$/) ? c.code.match(/-(T|P)$/)[0] : '';
        expandedCourses.push({
          ...c,
          code: `${base}_C${cl}${suffix}`,
          classNum: cl
        });
      }
    } else {
      expandedCourses.push(c);
    }
  });

  weekdays.forEach(day => {
    const categoriesMap = {};
    expandedCourses.forEach(c => {
      const cat = getTimetableRowCategory(c);
      if (!categoriesMap[cat]) categoriesMap[cat] = [];
      categoriesMap[cat].push(c);
    });

    const categories = Object.keys(categoriesMap).sort((a, b) => {
      const getPriority = (x) => {
        if (x.includes("MSC")) return 1;
        if (x.includes("BSC")) return 2;
        if (x.includes("MINOR")) return 3;
        return 4;
      };
      return getPriority(a) - getPriority(b) || a.localeCompare(b);
    });

    let weekdayTotalRows = 0;
    const categoryLayouts = {};

    categories.forEach(cat => {
      const catCourses = categoriesMap[cat];
      const subRows = [];

      catCourses.forEach(course => {
        const coursePeriods = [];
        periods.forEach(p => {
          if (p.toUpperCase() === 'LB') return;
          const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
          if (assigned.length > 0) coursePeriods.push(p);
        });

        if (coursePeriods.length === 0) return;

        let placed = false;
        for (let r = 0; r < subRows.length; r++) {
          const hasClash = coursePeriods.some(p => !!subRows[r][p]);
          if (!hasClash) {
            coursePeriods.forEach(p => {
              const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][p]) === 'P';
              const printClass = course.courseType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
              const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
              const tooltip = assigned.map(code => {
                const facObj = state.faculty.find(f => f.code === code);
                return facObj ? facObj.name : code;
              }).join(' / ');
              
              subRows[r][p] = {
                html: formatAllocationCell(course, day, p, allocations, displayMode),
                classes: printClass,
                tooltip: tooltip
              };
            });
            placed = true;
            break;
          }
        }

        if (!placed) {
          const newRow = {};
          coursePeriods.forEach(p => {
            const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][p]) === 'P';
            const printClass = course.courseType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
            const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
            const tooltip = assigned.map(code => {
              const facObj = state.faculty.find(f => f.code === code);
              return facObj ? facObj.name : code;
            }).join(' / ');

            newRow[p] = {
              html: formatAllocationCell(course, day, p, allocations, displayMode),
              classes: printClass,
              tooltip: tooltip
            };
          });
          subRows.push(newRow);
        }
      });

      if (subRows.length === 0) subRows.push({});
      categoryLayouts[cat] = subRows;
      weekdayTotalRows += subRows.length;
    });

    categories.forEach((cat, catIdx) => {
      const subRows = categoryLayouts[cat];
      subRows.forEach((srow, sidx) => {
        const tr = document.createElement('tr');
        
        if (catIdx === 0 && sidx === 0) {
          const tdDay = document.createElement('td');
          tdDay.rowSpan = weekdayTotalRows;
          tdDay.className = 'day-cell';
          tdDay.textContent = weekdayShort[day];
          tr.appendChild(tdDay);
        }

        if (sidx === 0) {
          const tdClass = document.createElement('td');
          tdClass.rowSpan = subRows.length;
          tdClass.className = 'class-cell';
          tdClass.textContent = cat;
          tr.appendChild(tdClass);
        }

        periods.forEach(p => {
          const td = document.createElement('td');
          if (p.toUpperCase() === 'LB') {
            td.className = 'break-cell';
            td.textContent = 'LB';
          } else {
            const cellData = srow[p];
            if (cellData) {
              td.innerHTML = cellData.html || '';
              if (cellData.classes) {
                cellData.classes.split(' ').filter(Boolean).forEach(cls => td.classList.add(cls));
              }
              if (cellData.tooltip) {
                td.setAttribute('title', cellData.tooltip);
              }
            } else {
              td.innerHTML = '';
            }
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    });
  });
}

function formatAllocationCell(course, day, period, allocations, mode) {
  const assignedCodes = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][period]) || [];
  if (assignedCodes.length === 0) return '';

  const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNum = course.classNum || (course.code.match(/(_G|_C)(\d+)/) ? course.code.match(/(_G|_C)(\d+)/)[2] : ((course.class && course.class > 0) ? course.class : ((course.group && course.group > 0) ? course.group : null)));
  const groupSuffix = classNum ? ` (C${classNum})` : '';
  const isPractical = course.code.endsWith('-P') || (course.recommendations[day] && course.recommendations[day][period]) === 'P';

  let suffix = '';
  if (mode === 'full') {
    if (course.courseType === 'M') {
      suffix = ' (M)';
    } else {
      suffix = isPractical ? ' (PR)' : ' (TH)';
    }
  }

  if (mode === 'short') {
    return `${assignedCodes.join('/')} ${alias}${groupSuffix}${suffix}`;
  } else if (mode === 'medium') {
    return `${assignedCodes.join('/')} - ${alias}${groupSuffix}${suffix}`;
  } else {
    const facNames = assignedCodes.map(code => {
      const facObj = state.faculty.find(f => f.code === code);
      return facObj ? facObj.name : code;
    }).join(' / ');
    const cleanName = course.name.replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, '');
    return `<div class="bold">${facNames}</div><div class="text-sm">${cleanName}${groupSuffix}${suffix}</div>`;
  }
}


function exportPrintTimetableToCSV() {
  const table = document.getElementById('print-grid-table');
  let csv = [];
  const ths = table.querySelectorAll('thead th');
  csv.push(Array.from(ths).map(th => `"${th.textContent}"`).join(','));
  
  const trs = table.querySelectorAll('tbody tr');
  let currentDay = '';
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    let tdValues = Array.from(tds).map(td => td.textContent.replace(/[\n\r]+/g, ' ').trim());
    if (tds[0] && tds[0].className === 'day-cell') {
      currentDay = tdValues[0];
    } else {
      tdValues.unshift(currentDay);
    }
    csv.push(tdValues.map(v => `"${v}"`).join(','));
  });
  
  const csvContent = "data:text/csv;charset=utf-8," + csv.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${activePrintDept}_Timetable_Grid_${state.config.academicYear}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


// =============================================================
// TEACHER-WISE TIMETABLE ENGINE & PDF EXPORT
// =============================================================

function computeFacultyWeeklySchedules(deptName) {
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

  const schedules = {};
  deptFaculty.forEach(fac => {
    schedules[fac.code] = {
      info: fac,
      totalHours: 0,
      theoryHours: 0,
      practicalHours: 0,
      slots: {}
    };
    weekdays.forEach(d => {
      schedules[fac.code].slots[d] = {};
    });
  });

  const deptAlloc = state.allocations || {};

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    const baseCode = cCode.replace(/-(T|P)$/, '').replace(/_C\d+-(T|P)$/, '').replace(/_C\d+$/, '').replace(/_G\d+$/, '');
    const course = state.courses.find(c => c.code === cCode) || 
                   state.courses.find(c => c.code === baseCode) || 
                   { code: cCode, name: cCode, alias: cCode, semester: '-', category: '-', courseType: 'T' };

    const isPrac = (course.courseType === 'P' || cCode.endsWith('-P'));

    Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (Array.isArray(facList)) {
          facList.forEach(facCode => {
            if (schedules[facCode]) {
              if (!schedules[facCode].slots[dayUpper]) {
                schedules[facCode].slots[dayUpper] = {};
              }
              if (!schedules[facCode].slots[dayUpper][period]) {
                schedules[facCode].slots[dayUpper][period] = [];
              }
              schedules[facCode].slots[dayUpper][period].push({
                courseCode: cCode,
                courseName: course.name,
                courseAlias: course.alias || course.name,
                semester: course.semester,
                category: course.category,
                type: isPrac ? 'P' : 'T'
              });
              schedules[facCode].totalHours++;
              if (isPrac) {
                schedules[facCode].practicalHours++;
              } else {
                schedules[facCode].theoryHours++;
              }
            }
          });
        }
      });
    });
  });

  // Include Common Batches in faculty schedules for locked periods
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const commonBatches = state.commonBatches || [];
  
  commonBatches.forEach(b => {
    const bSubj = (b.subjectCode || '').trim().toUpperCase();
    const bSem = String(b.semester || '').trim();
    
    const matchingLocks = globalLocks.filter(l => {
      const lUpper = (l.label || '').trim().toUpperCase();
      const lSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
      const matchLabel = (lUpper === bSubj) || (bSubj && lUpper.includes(bSubj)) || (lUpper && bSubj.includes(lUpper));
      const matchSem = (!lSem || lSem === 'all' || lSem === bSem.toLowerCase());
      return matchLabel && matchSem;
    });

    // Collect teacher codes
    const teacherCodes = Array.isArray(b.teachers) && b.teachers.length > 0
      ? b.teachers
      : (b.teacherCode ? b.teacherCode.split(',').map(s => s.trim()) : []);

    matchingLocks.forEach(l => {
      const dayUpper = (l.day || '').toUpperCase();
      const period = String(l.period || '').trim();
      if (!dayUpper || !period) return;

      teacherCodes.forEach(tCode => {
        if (schedules[tCode]) {
          if (!schedules[tCode].slots[dayUpper]) {
            schedules[tCode].slots[dayUpper] = {};
          }
          if (!schedules[tCode].slots[dayUpper][period]) {
            schedules[tCode].slots[dayUpper][period] = [];
          }
          const already = schedules[tCode].slots[dayUpper][period].some(x => x.courseCode === (b.courseCode || b.subjectCode) && x.batchName === b.batchName);
          if (!already) {
            schedules[tCode].slots[dayUpper][period].push({
              courseCode: b.courseCode || b.subjectCode,
              courseName: `${b.batchName}: ${b.courseName || b.courseCode || b.subjectCode}`,
              courseAlias: `${b.batchName} (${b.subjectCode})`,
              semester: b.semester,
              category: b.subjectCode || 'MDC',
              type: 'T',
              batchName: b.batchName
            });
            schedules[tCode].totalHours++;
            schedules[tCode].theoryHours++;
          }
        }
      });
    });
  });

  return schedules;
}

function renderTeacherTimetableSheet(facSchedule, displayMode, periods, deptName) {
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const fac = facSchedule.info;

  let theadHtml = `
    <tr>
      <th class="teacher-day-th">Day</th>
      ${periods.map(p => `<th>${String(p).toUpperCase() === 'LB' ? 'Lunch Break' : `Period ${p}`}</th>`).join('')}
    </tr>
  `;

  let tbodyHtml = '';
  weekdays.forEach(day => {
    let cellsHtml = `<td class="teacher-day-cell"><strong>${day}</strong></td>`;
    periods.forEach(p => {
      const pUpper = String(p).toUpperCase();
      if (pUpper === 'LB') {
        cellsHtml += `<td class="teacher-slot-lb">LB</td>`;
        return;
      }

      const assignedList = facSchedule.slots[day] && facSchedule.slots[day][p];
      if (assignedList && assignedList.length > 0) {
        const itemHtmls = assignedList.map(item => {
          const isP = item.type === 'P';
          const typeLabel = isP ? 'PR' : 'TH';
          
          let dispText = item.courseAlias;
          if (displayMode === 'short') {
            dispText = item.courseCode;
          } else if (displayMode === 'full') {
            dispText = `${item.courseName} (${item.courseCode})`;
          } else {
            dispText = `${item.courseAlias || item.courseCode}`;
          }

          const semLabel = item.semester && item.semester !== '-' ? `Sem ${item.semester}` : '';

          return `
            <div class="teacher-slot-inner">
              <span class="teacher-slot-course" title="${item.courseName} (${item.courseCode})">${dispText}</span>
              <div style="display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 2px;">
                ${semLabel ? `<span class="teacher-slot-sem-pill">${semLabel}</span>` : ''}
                <span class="teacher-slot-type-badge">${typeLabel}</span>
              </div>
            </div>
          `;
        }).join('<div style="border-top: 1px dashed rgba(0,0,0,0.15); margin: 3px 0;"></div>');

        const primaryTypeClass = assignedList.some(x => x.type === 'P') ? 'teacher-slot-pr' : 'teacher-slot-th';
        cellsHtml += `<td class="${primaryTypeClass}">${itemHtmls}</td>`;
      } else {
        cellsHtml += `<td class="teacher-slot-free">—</td>`;
      }
    });

    tbodyHtml += `<tr>${cellsHtml}</tr>`;
  });

  return `
    <div class="teacher-sheet-page">
      <div class="print-header text-center" style="margin-bottom: 12px;">
        <h2 style="font-size: 16px; margin: 0; font-weight: 800; letter-spacing: 0.5px;">ST. THOMAS COLLEGE (AUTONOMOUS), THRISSUR</h2>
        <h3 style="font-size: 14px; margin: 2px 0; color: #475569;">DEPARTMENT OF ${deptName}</h3>
        <h4 style="font-size: 12px; margin: 0; color: #64748b; font-weight: 600;">TEACHER INDIVIDUAL TIMETABLE & WORKLOAD – <span class="uppercase">${state.config.semesterType || 'ODD'} SEMESTER</span> ${state.config.academicYear || ''}</h4>
      </div>

      <div class="teacher-meta-header">
        <div class="teacher-meta-left">
          <h3>
            <i class="fa-solid fa-user-tie text-primary"></i> ${fac.name} 
            <span class="teacher-code-pill">${fac.code}</span>
          </h3>
          <span class="text-muted text-sm">${fac.designation || 'Faculty Member'} | Department of ${deptName}</span>
        </div>
        <div class="teacher-meta-right">
          <span class="teacher-stat-badge teacher-stat-total" title="Total teaching periods per week">
            <i class="fa-solid fa-clock"></i> Total: <strong>${facSchedule.totalHours} hrs/week</strong>
          </span>
          <span class="teacher-stat-badge teacher-stat-th" title="Theory hours per week">
            <i class="fa-solid fa-book-open"></i> Theory: <strong>${facSchedule.theoryHours} hrs</strong>
          </span>
          <span class="teacher-stat-badge teacher-stat-pr" title="Practical lab hours per week">
            <i class="fa-solid fa-flask"></i> Practical: <strong>${facSchedule.practicalHours} hrs</strong>
          </span>
        </div>
      </div>

      <table class="teacher-grid-table">
        <thead>${theadHtml}</thead>
        <tbody>${tbodyHtml}</tbody>
      </table>
    </div>
  `;
}

function renderTeacherTimetables(containerElement, targetFacultyCode = 'ALL', displayMode = 'medium') {
  if (!containerElement) return;
  const deptName = state.currentUser ? state.currentUser.departmentName : 'Department';
  const schedules = computeFacultyWeeklySchedules(deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];

  const facultyList = targetFacultyCode === 'ALL'
    ? Object.values(schedules)
    : [schedules[targetFacultyCode]].filter(Boolean);

  if (facultyList.length === 0) {
    containerElement.innerHTML = `
      <div class="text-center text-muted" style="padding: 40px 20px;">
        <i class="fa-solid fa-user-slash" style="font-size: 36px; margin-bottom: 12px; color: #cbd5e1;"></i>
        <p>No faculty members found for this department.</p>
      </div>
    `;
    return;
  }

  containerElement.innerHTML = facultyList.map(facSched => {
    return renderTeacherTimetableSheet(facSched, displayMode, periods, deptName);
  }).join('');
}

function populateTeacherTimetableDropdowns() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  const modalSelect = document.getElementById('select-teacher-timetable-faculty');
  const tabSelect = document.getElementById('tab-select-teacher-faculty');

  const optionsHtml = `
    <option value="ALL">All Teachers (${deptFaculty.length} Faculty Members)</option>
    ${deptFaculty.map(f => `<option value="${f.code}">${f.name} (${f.code})</option>`).join('')}
  `;

  if (modalSelect) modalSelect.innerHTML = optionsHtml;
  if (tabSelect) tabSelect.innerHTML = optionsHtml;
}

function openTeacherTimetableModal(selectedFacultyCode = 'ALL') {
  populateTeacherTimetableDropdowns();
  
  const modalSelect = document.getElementById('select-teacher-timetable-faculty');
  if (modalSelect) {
    modalSelect.value = selectedFacultyCode;
  }

  const modeSelect = document.getElementById('select-teacher-timetable-mode');
  const mode = modeSelect ? modeSelect.value : 'medium';

  const container = document.getElementById('teacher-print-area');
  renderTeacherTimetables(container, selectedFacultyCode, mode);

  const modal = document.getElementById('modal-teacher-timetable');
  if (modal) modal.classList.remove('hidden');
}

function renderTeacherTimetablesTab() {
  populateTeacherTimetableDropdowns();
  const tabSelect = document.getElementById('tab-select-teacher-faculty');
  const selectedFacultyCode = tabSelect ? tabSelect.value : 'ALL';
  const container = document.getElementById('tab-teacher-timetable-container');
  renderTeacherTimetables(container, selectedFacultyCode, 'medium');
}

function exportTeacherTimetableToCSV(targetFacultyCode = 'ALL') {
  const deptName = state.currentUser ? state.currentUser.departmentName : 'Department';
  const schedules = computeFacultyWeeklySchedules(deptName);
  const periods = state.config.periods || ["1", "2", "3", "LB", "4", "5", "6"];
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

  const facultyList = targetFacultyCode === 'ALL'
    ? Object.values(schedules)
    : [schedules[targetFacultyCode]].filter(Boolean);

  let csvRows = [];
  csvRows.push([`ST. THOMAS COLLEGE (AUTONOMOUS) - DEPARTMENT OF ${deptName}`]);
  csvRows.push([`TEACHER TIMETABLE REPORT - ${state.config.semesterType || 'ODD'} SEMESTER ${state.config.academicYear || ''}`]);
  csvRows.push([]);

  facultyList.forEach(facSched => {
    const fac = facSched.info;
    csvRows.push([`Teacher:`, `"${fac.name}"`, `Code:`, `"${fac.code}"`, `Workload:`, `"${facSched.totalHours} hrs/week (${facSched.theoryHours} TH, ${facSched.practicalHours} PR)"`]);
    csvRows.push(['Day', ...periods.map(p => String(p).toUpperCase() === 'LB' ? 'LB' : `Period ${p}`)]);

    weekdays.forEach(day => {
      const row = [day];
      periods.forEach(p => {
        if (String(p).toUpperCase() === 'LB') {
          row.push('Lunch Break');
          return;
        }
        const assigned = facSched.slots[day] && facSched.slots[day][p];
        if (assigned && assigned.length > 0) {
          const text = assigned.map(a => `${a.courseAlias || a.courseCode} (Sem ${a.semester}, ${a.type})`).join(' / ');
          row.push(`"${text}"`);
        } else {
          row.push('Free');
        }
      });
      csvRows.push(row);
    });
    csvRows.push([]);
  });

  const csvString = csvRows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const filename = targetFacultyCode === 'ALL'
    ? `${deptName}_All_Teachers_Timetable_${state.config.academicYear || '2026'}.csv`
    : `${deptName}_Teacher_${targetFacultyCode}_Timetable_${state.config.academicYear || '2026'}.csv`;
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function bindTeacherTimetableEvents() {
  const btnOpenToolbar = document.getElementById('btn-open-teacher-timetable');
  if (btnOpenToolbar) {
    btnOpenToolbar.addEventListener('click', () => {
      openTeacherTimetableModal('ALL');
    });
  }

  const btnCloseModal = document.getElementById('btn-close-teacher-modal');
  if (btnCloseModal) {
    btnCloseModal.addEventListener('click', () => {
      const modal = document.getElementById('modal-teacher-timetable');
      if (modal) modal.classList.add('hidden');
    });
  }

  const modalSelectFac = document.getElementById('select-teacher-timetable-faculty');
  const modalSelectMode = document.getElementById('select-teacher-timetable-mode');
  const printArea = document.getElementById('teacher-print-area');

  if (modalSelectFac && printArea) {
    modalSelectFac.addEventListener('change', () => {
      const mode = modalSelectMode ? modalSelectMode.value : 'medium';
      renderTeacherTimetables(printArea, modalSelectFac.value, mode);
    });
  }

  if (modalSelectMode && printArea) {
    modalSelectMode.addEventListener('change', () => {
      const facCode = modalSelectFac ? modalSelectFac.value : 'ALL';
      renderTeacherTimetables(printArea, facCode, modalSelectMode.value);
    });
  }

  const btnPrint = document.getElementById('btn-trigger-teacher-print');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      window.print();
    });
  }

  const btnExportCsv = document.getElementById('btn-export-teacher-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      const facCode = modalSelectFac ? modalSelectFac.value : 'ALL';
      exportTeacherTimetableToCSV(facCode);
    });
  }

  // Tab controls
  const tabSelectFac = document.getElementById('tab-select-teacher-faculty');
  const tabContainer = document.getElementById('tab-teacher-timetable-container');
  if (tabSelectFac && tabContainer) {
    tabSelectFac.addEventListener('change', () => {
      renderTeacherTimetables(tabContainer, tabSelectFac.value, 'medium');
    });
  }

  const tabBtnModal = document.getElementById('tab-btn-open-teacher-modal');
  if (tabBtnModal) {
    tabBtnModal.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
    });
  }

  const tabBtnPrint = document.getElementById('tab-btn-print-teacher-pdf');
  if (tabBtnPrint) {
    tabBtnPrint.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
      setTimeout(() => {
        window.print();
      }, 350);
    });
  }

  const btnSwitchTeacher = document.getElementById('btn-switch-to-teacher-timetable');
  if (btnSwitchTeacher) {
    btnSwitchTeacher.addEventListener('click', () => {
      const printModal = document.getElementById('modal-print-preview');
      if (printModal) printModal.classList.add('hidden');
      openTeacherTimetableModal('ALL');
    });
  }
}


// -------------------------------------------------------------
// Department Group & Batch Assignment Modal Helpers
// -------------------------------------------------------------
window.openDeptBatchMappingModal = function(courseCode) {
  const course = state.courses.find(c => c.code === courseCode);
  if (!course) return;

  document.getElementById('dept-mapping-course-code').value = courseCode;
  document.getElementById('dept-mapping-course-title').textContent = `${course.code} - ${course.name}`;
  document.getElementById('dept-mapping-course-meta').textContent = `Semester: ${course.semester} | Category: ${course.category}`;
  
  const currentCount = course.classes || 1;

  const countSelect = document.getElementById('dept-group-count-select');
  countSelect.value = String(currentCount);

  // Populate datalist options with all batches
  const datalist = document.getElementById('dept-batch-datalist');
  if (datalist) {
    datalist.innerHTML = '';
    state.allBatches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.batchId;
      opt.textContent = `${b.batchId} - ${b.batchLabel}`;
      datalist.appendChild(opt);
    });
  }

  // Calculate default batch ID
  const deptName = state.currentUser.departmentName.toUpperCase();
  const programCode = course.programType === 'PG' ? 'P' : 'U';
  const fundingCode = '1'; // Aided only

  const batchForDept = state.allBatches.find(b => b.deptName && b.deptName.toUpperCase() === deptName);
  const deptCode = batchForDept ? batchForDept.deptCode : '';

  const batchForYear = state.allBatches.find(b => b.semesters && b.semesters.map(String).includes(String(course.semester)));
  const year = batchForYear ? batchForYear.year : '';

  const defaultBatchId = (programCode + fundingCode + deptCode + year).toUpperCase();

  renderDeptGroupSelects(course, defaultBatchId);

  document.getElementById('modal-dept-group-mapping').classList.remove('hidden');
};

function renderDeptGroupSelects(course, defaultBatchId) {
  const listContainer = document.getElementById('dept-group-selectors-list');
  listContainer.innerHTML = '';

  const countSelect = document.getElementById('dept-group-count-select');
  const count = parseInt(countSelect.value) || 1;

  const cleanCode = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');

  for (let i = 1; i <= count; i++) {
    const div = document.createElement('div');
    div.className = 'form-group mb-2';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '4px';

    const label = document.createElement('label');
    label.style.fontWeight = '600';
    label.style.fontSize = '12px';
    label.textContent = count > 1 ? `Class ${i} (C${i}) Batch:` : 'Class Batch:';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control dept-group-select-item';
    input.setAttribute('list', 'dept-batch-datalist');
    input.placeholder = 'Type department or code...';
    input.dataset.groupIndex = i;

    // Load preselected batch dynamically matching C{i} or fallback to default
    let savedBatch = '';
    if (count > 1) {
      savedBatch = (state.groupMappings[`${cleanCode}_C${i}`] && state.groupMappings[`${cleanCode}_C${i}`][0]) || 
                   (state.groupMappings[`${cleanCode}_G${i}`] && state.groupMappings[`${cleanCode}_G${i}`][0]) || '';
    } else {
      savedBatch = (state.groupMappings[cleanCode] && state.groupMappings[cleanCode][0]) || '';
    }

    const preselected = savedBatch || defaultBatchId;
    input.value = preselected;

    // Focus input to highlight current value on click
    input.addEventListener('click', () => {
      input.select();
    });

    div.appendChild(label);
    div.appendChild(input);
    listContainer.appendChild(div);
  }
}

// ==========================================================================
// Advanced Features Suite Modal Controller & Unsaved Changes Guard
// ==========================================================================
let tempGeneratedAllocations = null;
let activeAdvancedFeaturesTab = 'adv-pane-teacher-unavail';
let localSubjectMappings = {};
let autoGenCourseFacultyBindings = {};
let autoGenCourseFacultyConfig = {};

// Snapshots for tracking unsaved modifications
let savedTeacherUnavailSnapshot = null;
let savedSubjectMappingsSnapshot = null;
let savedCurriculumRecsSnapshot = null;
let savedCurriculumBlocksSnapshot = null;

function updateTeacherUnavailSnapshot() {
  if (!activeUnavailTeacherCode) {
    savedTeacherUnavailSnapshot = null;
    return;
  }
  const sorted = (localTeacherUnavail || []).slice().sort((a, b) => `${a.day}-${a.period}`.localeCompare(`${b.day}-${b.period}`));
  savedTeacherUnavailSnapshot = JSON.stringify(sorted);
}

function updateSubjectMappingsSnapshot() {
  savedSubjectMappingsSnapshot = JSON.stringify(localSubjectMappings || {});
}

function updateCurriculumSlotsSnapshot() {
  savedCurriculumRecsSnapshot = JSON.stringify(localCurriculumCourseRecs || {});
  savedCurriculumBlocksSnapshot = JSON.stringify(localCurriculumSemesterBlocks || []);
}

function getTeacherUnavailUnsavedChanges() {
  if (!activeUnavailTeacherCode) return null;
  const currentSorted = (localTeacherUnavail || []).slice().sort((a, b) => `${a.day}-${a.period}`.localeCompare(`${b.day}-${b.period}`));
  const currentStr = JSON.stringify(currentSorted);

  if (savedTeacherUnavailSnapshot === null) {
    savedTeacherUnavailSnapshot = currentStr;
    return null;
  }
  if (currentStr === savedTeacherUnavailSnapshot) {
    return null;
  }

  let savedList = [];
  try {
    savedList = JSON.parse(savedTeacherUnavailSnapshot);
  } catch (e) {
    savedList = [];
  }

  const savedKeySet = new Set(savedList.map(s => `${s.day.toUpperCase()} Period ${s.period}`));
  const currentKeySet = new Set((localTeacherUnavail || []).map(s => `${s.day.toUpperCase()} Period ${s.period}`));

  const added = [];
  const removed = [];

  currentKeySet.forEach(key => {
    if (!savedKeySet.has(key)) added.push(key);
  });
  savedKeySet.forEach(key => {
    if (!currentKeySet.has(key)) removed.push(key);
  });

  if (added.length === 0 && removed.length === 0) return null;

  const facObj = (state.faculty || []).find(f => f.code === activeUnavailTeacherCode);
  const teacherName = facObj ? `${facObj.name} (${activeUnavailTeacherCode})` : activeUnavailTeacherCode;

  const changes = [];
  if (added.length > 0) {
    changes.push(`<strong>Marked ${added.length} blackout period(s) for ${teacherName}:</strong> ${added.slice(0, 4).join(', ')}${added.length > 4 ? ` (+${added.length - 4} more)` : ''}`);
  }
  if (removed.length > 0) {
    changes.push(`<strong>Cleared ${removed.length} blackout period(s) for ${teacherName}:</strong> ${removed.slice(0, 4).join(', ')}${removed.length > 4 ? ` (+${removed.length - 4} more)` : ''}`);
  }

  return {
    tabId: 'adv-pane-teacher-unavail',
    tabName: 'Teacher Availability',
    changes,
    revert: () => {
      try {
        localTeacherUnavail = JSON.parse(savedTeacherUnavailSnapshot);
      } catch (e) {
        localTeacherUnavail = [];
      }
      loadTeacherUnavailMatrix();
    },
    save: async () => {
      const btn = document.getElementById('btn-save-teacher-unavailability');
      if (btn) btn.click();
    }
  };
}

function getSubjectMappingUnsavedChanges() {
  if (savedSubjectMappingsSnapshot === null) {
    savedSubjectMappingsSnapshot = JSON.stringify(localSubjectMappings || {});
    return null;
  }
  const currentStr = JSON.stringify(localSubjectMappings || {});
  if (currentStr === savedSubjectMappingsSnapshot) {
    return null;
  }

  let savedMap = {};
  try {
    savedMap = JSON.parse(savedSubjectMappingsSnapshot);
  } catch (e) {
    savedMap = {};
  }

  const modifiedCourses = [];

  Object.entries(localSubjectMappings || {}).forEach(([cCode, current]) => {
    const saved = savedMap[cCode];
    if (!saved) return;

    const diffs = [];
    if (parseInt(current.hours) !== parseInt(saved.hours)) {
      diffs.push(`Weekly Hours changed from ${saved.hours} to ${current.hours}`);
    }
    if (current.courseType !== saved.courseType) {
      diffs.push(`Type changed from ${saved.courseType} to ${current.courseType}`);
    }
    if (parseInt(current.practicalHours || 0) !== parseInt(saved.practicalHours || 0)) {
      diffs.push(`Practical Hours changed from ${saved.practicalHours || 0} to ${current.practicalHours || 0}`);
    }

    const curTeachers = (current.teachers || []).slice().sort().join(', ');
    const savTeachers = (saved.teachers || []).slice().sort().join(', ');
    if (curTeachers !== savTeachers) {
      diffs.push(`Assigned Teachers changed from [${savTeachers || 'None'}] to [${curTeachers || 'None'}]`);
    }

    const curHoursStr = JSON.stringify(current.teacherHours || {});
    const savHoursStr = JSON.stringify(saved.teacherHours || {});
    if (curHoursStr !== savHoursStr && curTeachers === savTeachers) {
      diffs.push(`Teacher hours breakdown modified`);
    }

    if (diffs.length > 0) {
      const course = (state.courses || []).find(c => c.code === cCode);
      const name = course ? course.name : cCode;
      modifiedCourses.push(`<strong>${cCode} (${name}):</strong> ${diffs.join('; ')}`);
    }
  });

  if (modifiedCourses.length === 0) return null;

  return {
    tabId: 'adv-pane-subject-mapping',
    tabName: 'Subject Teacher Mapping',
    changes: modifiedCourses,
    revert: () => {
      try {
        localSubjectMappings = JSON.parse(savedSubjectMappingsSnapshot);
      } catch (e) {
        localSubjectMappings = {};
      }
      renderSubjectMappingTiles();
    },
    save: async () => {
      await saveAllSubjectMappings();
    }
  };
}

function getCurriculumSlotsUnsavedChanges() {
  if (savedCurriculumRecsSnapshot === null) {
    savedCurriculumRecsSnapshot = JSON.stringify(localCurriculumCourseRecs || {});
    savedCurriculumBlocksSnapshot = JSON.stringify(localCurriculumSemesterBlocks || []);
    return null;
  }

  const currentRecsStr = JSON.stringify(localCurriculumCourseRecs || {});
  const currentBlocksStr = JSON.stringify(localCurriculumSemesterBlocks || []);

  if (currentRecsStr === savedCurriculumRecsSnapshot && currentBlocksStr === savedCurriculumBlocksSnapshot) {
    return null;
  }

  let savedRecs = {};
  let savedBlocks = [];
  try {
    savedRecs = JSON.parse(savedCurriculumRecsSnapshot);
    savedBlocks = JSON.parse(savedCurriculumBlocksSnapshot);
  } catch (e) {}

  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  const deptCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === deptName);

  const changedCourses = [];

  deptCourses.forEach(c => {
    const curRec = (localCurriculumCourseRecs && localCurriculumCourseRecs[c.code]) || {};
    const savRec = savedRecs[c.code] || {};
    const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    const diffs = [];

    days.forEach(day => {
      const curDay = curRec[day] || {};
      const savDay = savRec[day] || {};
      const periods = new Set([...Object.keys(curDay), ...Object.keys(savDay)]);
      periods.forEach(p => {
        const curVal = curDay[p] || '';
        const savVal = savDay[p] || '';
        if (curVal !== savVal) {
          const valLabel = (v) => v === 'B' ? 'Blocked' : (v === 'T' ? 'Theory' : (v === 'P' ? 'Practical' : v));
          if (curVal && !savVal) diffs.push(`added ${valLabel(curVal)} at ${day} P${p}`);
          else if (!curVal && savVal) diffs.push(`removed ${valLabel(savVal)} at ${day} P${p}`);
          else diffs.push(`changed ${valLabel(savVal)}->${valLabel(curVal)} at ${day} P${p}`);
        }
      });
    });

    if (diffs.length > 0) {
      changedCourses.push(`<strong>${c.code} (${c.name}):</strong> ${diffs.slice(0, 3).join(', ')}${diffs.length > 3 ? ` (+${diffs.length - 3} more)` : ''}`);
    }
  });

  if (currentBlocksStr !== savedCurriculumBlocksSnapshot) {
    changedCourses.push(`<strong>Semester Blocked Periods:</strong> Custom blackout periods modified`);
  }

  if (changedCourses.length === 0) return null;

  return {
    tabId: 'adv-pane-curriculum-slots',
    tabName: 'Curriculum Slot Allocation',
    changes: changedCourses,
    revert: () => {
      try {
        localCurriculumCourseRecs = JSON.parse(savedCurriculumRecsSnapshot);
        localCurriculumSemesterBlocks = JSON.parse(savedCurriculumBlocksSnapshot);
      } catch (e) {}
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
    },
    save: async () => {
      await saveCurriculumSlotAllocations();
    }
  };
}

function getChangePasswordUnsavedChanges() {
  const currentPwd = (document.getElementById('dept-current-pwd')?.value || '').trim();
  const newPwd = (document.getElementById('dept-new-pwd')?.value || '').trim();
  const confirmPwd = (document.getElementById('dept-confirm-pwd')?.value || '').trim();

  if (newPwd || currentPwd || confirmPwd) {
    return {
      tabId: 'adv-pane-change-password',
      tabName: 'Change Password',
      changes: ['Entered new password details have not been submitted.'],
      revert: () => {
        const form = document.getElementById('form-dept-change-password');
        if (form) form.reset();
      },
      save: null
    };
  }
  return null;
}

function getAutoGenUnsavedChanges() {
  if (tempGeneratedAllocations && typeof tempGeneratedAllocations === 'object' && Object.keys(tempGeneratedAllocations).length > 0) {
    return {
      tabId: 'adv-pane-auto-generate',
      tabName: 'Auto Generate',
      changes: ['Auto-generated schedule preview has been created but not applied to your timetable.'],
      revert: () => {
        tempGeneratedAllocations = null;
        const preview = document.getElementById('auto-gen-preview-container');
        if (preview) preview.classList.add('hidden');
      },
      save: async () => {
        await applyAutoGeneratedSchedule();
      }
    };
  }
  return null;
}

function getUnsavedChangesForTab(tabId) {
  if (tabId === 'adv-pane-teacher-unavail') {
    return getTeacherUnavailUnsavedChanges();
  } else if (tabId === 'adv-pane-subject-mapping') {
    return getSubjectMappingUnsavedChanges();
  } else if (tabId === 'adv-pane-curriculum-slots') {
    return getCurriculumSlotsUnsavedChanges();
  } else if (tabId === 'adv-pane-change-password') {
    return getChangePasswordUnsavedChanges();
  } else if (tabId === 'adv-pane-auto-generate') {
    return getAutoGenUnsavedChanges();
  }
  return null;
}

function showUnsavedChangesModal(unsavedInfo, onProceed) {
  const modal = document.getElementById('modal-unsaved-adv-changes');
  if (!modal) {
    if (confirm(`You have unsaved changes in ${unsavedInfo.tabName}. Do you want to discard them?`)) {
      if (unsavedInfo.revert) unsavedInfo.revert();
      onProceed();
    }
    return;
  }

  document.getElementById('unsaved-adv-modal-title').textContent = `Unsaved Changes in ${unsavedInfo.tabName}`;
  document.getElementById('unsaved-adv-tab-name').textContent = unsavedInfo.tabName;

  const listEl = document.getElementById('unsaved-adv-changes-list');
  listEl.innerHTML = '';
  unsavedInfo.changes.forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = item;
    listEl.appendChild(li);
  });

  const btnStay = document.getElementById('btn-unsaved-adv-stay');
  const btnDiscard = document.getElementById('btn-unsaved-adv-discard');
  const btnSave = document.getElementById('btn-unsaved-adv-save-proceed');

  if (unsavedInfo.save) {
    btnSave.classList.remove('hidden');
  } else {
    btnSave.classList.add('hidden');
  }

  // Clone buttons to strip old event listeners
  const newBtnStay = btnStay.cloneNode(true);
  btnStay.parentNode.replaceChild(newBtnStay, btnStay);

  const newBtnDiscard = btnDiscard.cloneNode(true);
  btnDiscard.parentNode.replaceChild(newBtnDiscard, btnDiscard);

  const newBtnSave = btnSave.cloneNode(true);
  btnSave.parentNode.replaceChild(newBtnSave, btnSave);

  newBtnStay.onclick = () => {
    modal.classList.add('hidden');
  };

  newBtnDiscard.onclick = () => {
    modal.classList.add('hidden');
    if (unsavedInfo.revert) unsavedInfo.revert();
    onProceed();
  };

  newBtnSave.onclick = async () => {
    if (unsavedInfo.save) {
      newBtnSave.disabled = true;
      newBtnSave.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
      try {
        await unsavedInfo.save();
        modal.classList.add('hidden');
        onProceed();
      } catch (err) {
        console.error(err);
        modal.classList.add('hidden');
      } finally {
        newBtnSave.disabled = false;
        newBtnSave.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save & Proceed`;
      }
    } else {
      modal.classList.add('hidden');
      onProceed();
    }
  };

  modal.classList.remove('hidden');
}

function checkUnsavedChangesAndProceed(activeTab, onProceed) {
  const unsaved = getUnsavedChangesForTab(activeTab);
  if (unsaved && unsaved.changes && unsaved.changes.length > 0) {
    showUnsavedChangesModal(unsaved, onProceed);
  } else {
    onProceed();
  }
}

function checkAnyUnsavedChangesBeforeClose(onProceed) {
  const activeUnsaved = getUnsavedChangesForTab(activeAdvancedFeaturesTab);
  if (activeUnsaved && activeUnsaved.changes && activeUnsaved.changes.length > 0) {
    showUnsavedChangesModal(activeUnsaved, onProceed);
    return;
  }

  const allTabs = [
    'adv-pane-teacher-unavail',
    'adv-pane-subject-mapping',
    'adv-pane-curriculum-slots',
    'adv-pane-change-password',
    'adv-pane-auto-generate'
  ];
  for (const tabId of allTabs) {
    if (tabId === activeAdvancedFeaturesTab) continue;
    const unsaved = getUnsavedChangesForTab(tabId);
    if (unsaved && unsaved.changes && unsaved.changes.length > 0) {
      showUnsavedChangesModal(unsaved, onProceed);
      return;
    }
  }

  onProceed();
}

function bindAutoGeneratorEvents() {
  bindAdvancedFeaturesModalEvents();
}

function bindAdvancedFeaturesModalEvents() {
  const btnOpen = document.getElementById('btn-open-advanced-features');
  const btnClose = document.getElementById('btn-close-advanced-features');
  const modal = document.getElementById('modal-advanced-features');

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      openAdvancedFeaturesModal('adv-pane-teacher-unavail');
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      checkAnyUnsavedChangesBeforeClose(() => {
        closeAdvancedFeaturesModal();
      });
    });
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        checkAnyUnsavedChangesBeforeClose(() => {
          closeAdvancedFeaturesModal();
        });
      }
    });
  }

  // Sidebar Tab Switching with Unsaved Changes Guard
  document.querySelectorAll('.adv-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const paneId = btn.getAttribute('data-pane');
      if (!paneId || paneId === activeAdvancedFeaturesTab) return;
      
      checkUnsavedChangesAndProceed(activeAdvancedFeaturesTab, () => {
        switchAdvancedFeaturesTab(paneId);
      });
    });
  });

  // Subject Teacher Mapping Controls
  const searchInput = document.getElementById('subject-mapping-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderSubjectMappingTiles();
    });
  }

  const mappingProgFilter = document.getElementById('subject-mapping-program-filter');
  if (mappingProgFilter) {
    mappingProgFilter.addEventListener('change', () => {
      populateSubjectMappingSemFilter();
      renderSubjectMappingTiles();
    });
  }

  const semFilter = document.getElementById('subject-mapping-sem-filter');
  if (semFilter) {
    semFilter.addEventListener('change', () => {
      renderSubjectMappingTiles();
    });
  }

  const sortSelect = document.getElementById('subject-mapping-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      renderSubjectMappingTiles();
    });
  }

  const btnSaveMapping = document.getElementById('btn-save-subject-mapping');
  if (btnSaveMapping) {
    btnSaveMapping.addEventListener('click', async () => {
      await saveAllSubjectMappings();
    });
  }

  // Common Subject Mapping Controls
  bindCommonSubjectMappingEvents();

  // Auto Generator Controls
  const autoGenProgSelect = document.getElementById('auto-gen-program-select');
  const autoGenCoursesProg = document.getElementById('auto-gen-courses-program');

  if (autoGenProgSelect) {
    autoGenProgSelect.addEventListener('change', () => {
      if (autoGenCoursesProg) autoGenCoursesProg.value = autoGenProgSelect.value;
      populateAutoGenSemFilter();
      renderAutoGeneratorBindings();
    });
  }

  if (autoGenCoursesProg) {
    autoGenCoursesProg.addEventListener('change', () => {
      if (autoGenProgSelect) autoGenProgSelect.value = autoGenCoursesProg.value;
      populateAutoGenSemFilter();
      renderAutoGeneratorBindings();
    });
  }

  const semSelect = document.getElementById('auto-gen-sem-select');
  if (semSelect) {
    semSelect.addEventListener('change', () => {
      renderAutoGeneratorBindings();
    });
  }

  const coursesSort = document.getElementById('auto-gen-courses-sort');
  if (coursesSort) {
    coursesSort.addEventListener('change', () => {
      renderAutoGeneratorBindings();
    });
  }

  const coursesSearch = document.getElementById('auto-gen-courses-search');
  if (coursesSearch) {
    coursesSearch.addEventListener('input', () => {
      renderAutoGeneratorBindings();
    });
  }

  const btnRun = document.getElementById('btn-run-auto-generate');
  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      await runAutoGeneration();
    });
  }

  const btnApply = document.getElementById('btn-apply-auto-generate');
  if (btnApply) {
    btnApply.addEventListener('click', async () => {
      await applyAutoGeneratedSchedule();
    });
  }

  // Teacher Timetable Tab Controls
  const tabSelectFac = document.getElementById('tab-select-teacher-faculty');
  const tabContainer = document.getElementById('tab-teacher-timetable-container');
  if (tabSelectFac && tabContainer) {
    tabSelectFac.addEventListener('change', () => {
      renderTeacherTimetables(tabContainer, tabSelectFac.value, 'medium');
    });
  }

  const tabBtnModal = document.getElementById('tab-btn-open-teacher-modal');
  if (tabBtnModal) {
    tabBtnModal.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
    });
  }

  const tabBtnPrint = document.getElementById('tab-btn-print-teacher-pdf');
  if (tabBtnPrint) {
    tabBtnPrint.addEventListener('click', () => {
      const facCode = tabSelectFac ? tabSelectFac.value : 'ALL';
      openTeacherTimetableModal(facCode);
      setTimeout(() => {
        window.print();
      }, 350);
    });
  }

  // Curriculum & Recommended Slots Controls
  bindCurriculumSlotAllocatorEvents();

  // Department Password Change Controls
  bindDeptChangePasswordEvents();
}

function openAdvancedFeaturesModal(initialPaneId = 'adv-pane-teacher-unavail') {
  if (isTimetableLocked() && initialPaneId !== 'adv-pane-change-password') {
    const deptName = state.currentUser ? state.currentUser.departmentName : '';
    const deptInfo = state.departments.find(d => d.name === deptName) || { status: 'Draft' };
    showModalAlert(
      'Timetable Locked',
      `Your timetable is currently ${deptInfo.status}. You cannot alter settings or generate allocations while it is locked.`,
      'info'
    );
    return;
  }

  const modal = document.getElementById('modal-advanced-features');
  if (!modal) return;
  modal.classList.remove('hidden');

  switchAdvancedFeaturesTab(initialPaneId);
}

function closeAdvancedFeaturesModal() {
  const modal = document.getElementById('modal-advanced-features');
  if (modal) modal.classList.add('hidden');
  selectedCommonSubjectCode = null;
}

function switchAdvancedFeaturesTab(paneId) {
  activeAdvancedFeaturesTab = paneId;

  // Toggle active sidebar tab button
  document.querySelectorAll('.adv-tab-btn').forEach(btn => {
    if (btn.getAttribute('data-pane') === paneId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Toggle pane visibility
  document.querySelectorAll('.adv-pane').forEach(pane => {
    if (pane.id === paneId) {
      pane.classList.remove('hidden');
    } else {
      pane.classList.add('hidden');
    }
  });

  // Trigger pane renderers
  if (paneId === 'adv-pane-teacher-unavail') {
    renderTeacherAvailabilityEditor();
  } else if (paneId === 'adv-pane-subject-mapping') {
    renderSubjectMappingTiles();
  } else if (paneId === 'adv-pane-common-subject-mapping') {
    renderCommonSubjectMappingTiles();
  } else if (paneId === 'adv-pane-auto-generate') {
    initAutoGeneratorPane();
  } else if (paneId === 'adv-pane-teacher-timetable') {
    renderTeacherTimetablesTab();
  } else if (paneId === 'adv-pane-curriculum-slots') {
    renderCurriculumSlotAllocator();
  } else if (paneId === 'adv-pane-change-password') {
    initDeptChangePasswordPane();
  }
}

// -------------------------------------------------------------
// TAB 2: Subject Teacher Mapping Renderer & State Logic
// -------------------------------------------------------------
function calculateDefaultPracticalSplit(totalHours) {
  totalHours = Math.max(1, parseInt(totalHours) || 4);
  if (totalHours <= 1) return { practical: 0, theory: totalHours };
  let half = Math.floor(totalHours / 2);
  let prac = half - (half % 2);
  if (prac < 2 && totalHours >= 2) prac = 2;
  if (prac > totalHours) prac = totalHours - (totalHours % 2);
  const theory = Math.max(0, totalHours - prac);
  return { practical: prac, theory: theory };
}

function calculateDefaultTeacherSplit(totalHours, teachers) {
  totalHours = Math.max(0, parseInt(totalHours) || 0);
  if (!Array.isArray(teachers) || teachers.length === 0) return {};
  const perTeacher = Math.floor(totalHours / teachers.length);
  let rem = totalHours % teachers.length;
  const result = {};
  teachers.forEach(fCode => {
    result[fCode] = perTeacher + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  });
  return result;
}

function validateAndBalanceTeacherHours(totalHours, teachers, existingHours) {
  totalHours = Math.max(1, parseInt(totalHours) || 4);
  if (!Array.isArray(teachers) || teachers.length === 0) return {};
  if (teachers.length === 1) return { [teachers[0]]: totalHours };

  const hoursObj = existingHours ? { ...existingHours } : {};
  let currentSum = 0;
  let allPresent = true;
  teachers.forEach(t => {
    if (hoursObj[t] === undefined || isNaN(parseInt(hoursObj[t])) || parseInt(hoursObj[t]) < 1) {
      allPresent = false;
    } else {
      currentSum += parseInt(hoursObj[t]);
    }
  });

  if (!allPresent || currentSum !== totalHours) {
    return calculateDefaultTeacherSplit(totalHours, teachers);
  }

  return hoursObj;
}

function updateSplitBadge(cCode, targetTotal, hoursObj, badgeId) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  const sum = Object.values(hoursObj || {}).reduce((a, b) => a + (parseInt(b) || 0), 0);
  if (sum === targetTotal) {
    badge.className = 'badge badge-success';
    badge.innerHTML = `<i class="fa-solid fa-check"></i> Total: ${sum} / ${targetTotal} hrs`;
  } else {
    badge.className = 'badge badge-danger';
    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Total: ${sum} / ${targetTotal} hrs (Mismatch!)`;
  }
}

function initLocalSubjectMappings() {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptUpper = deptName.toUpperCase();
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const savedMappings = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptUpper]) || {};

  deptCourses.forEach(c => {
    if (!localSubjectMappings[c.code]) {
      const saved = savedMappings[c.code] || {};
      const courseHours = parseInt(saved.hours || c.hours) || 4;
      const isPrac = (saved.courseType === 'P' || c.courseType === 'P' || c.code.endsWith('-P'));
      const courseType = isPrac ? 'P' : 'T';

      // Fallback teachers from existing allocations
      let fallbackTeachers = [];
      if (Array.isArray(saved.teachers) && saved.teachers.length > 0) {
        fallbackTeachers = saved.teachers;
      } else if (Array.isArray(c.teachers) && c.teachers.length > 0) {
        fallbackTeachers = c.teachers;
      } else if (autoGenCourseFacultyBindings[c.code] && autoGenCourseFacultyBindings[c.code].length > 0) {
        fallbackTeachers = autoGenCourseFacultyBindings[c.code];
      } else {
        const existingAlloc = state.allocations[c.code] || {};
        const assignedSet = new Set();
        Object.values(existingAlloc).forEach(dayObj => {
          Object.values(dayObj).forEach(facArr => {
            if (Array.isArray(facArr)) facArr.forEach(fc => assignedSet.add(fc));
          });
        });
        fallbackTeachers = Array.from(assignedSet);
      }

      if (courseType === 'P') {
        const defSplit = calculateDefaultPracticalSplit(courseHours);
        let practicalHours = (saved.practicalHours !== undefined && parseInt(saved.practicalHours) % 2 === 0)
          ? parseInt(saved.practicalHours)
          : defSplit.practical;
        if (practicalHours < 2 && courseHours >= 2) practicalHours = 2;
        const theoryHours = saved.theoryHours !== undefined
          ? parseInt(saved.theoryHours)
          : Math.max(0, courseHours - practicalHours);

        let practicalTeachers = (Array.isArray(saved.practicalTeachers) && saved.practicalTeachers.length > 0)
          ? saved.practicalTeachers
          : ((Array.isArray(c.practicalTeachers) && c.practicalTeachers.length > 0) ? c.practicalTeachers : fallbackTeachers);
        let theoryTeachers = (Array.isArray(saved.theoryTeachers) && saved.theoryTeachers.length > 0)
          ? saved.theoryTeachers
          : ((Array.isArray(c.theoryTeachers) && c.theoryTeachers.length > 0) ? c.theoryTeachers : []);
        
        // Validate and rebalance theory teacher hours so sum strictly matches theoryHours!
        let theoryTeacherHours = validateAndBalanceTeacherHours(theoryHours, theoryTeachers, saved.theoryTeacherHours || c.theoryTeacherHours);

        const unifiedTeachers = Array.from(new Set([...practicalTeachers, ...theoryTeachers]));
        const unifiedTeacherHours = { ...theoryTeacherHours };
        practicalTeachers.forEach(pt => {
          if (unifiedTeacherHours[pt] === undefined) unifiedTeacherHours[pt] = practicalHours;
        });

        localSubjectMappings[c.code] = {
          hours: courseHours,
          courseType: 'P',
          practicalHours: practicalHours,
          theoryHours: theoryHours,
          practicalTeachers: practicalTeachers,
          theoryTeachers: theoryTeachers,
          theoryTeacherHours: theoryTeacherHours,
          teachers: unifiedTeachers,
          teacherHours: unifiedTeacherHours
        };
        syncAutoGenConfigForCourse(c.code);
      } else {
        // Pure Theory
        let theoryTeachers = Array.isArray(saved.theoryTeachers) && saved.theoryTeachers.length > 0
          ? saved.theoryTeachers
          : fallbackTeachers;

        // Validate and rebalance teacher hours so sum strictly matches courseHours!
        let teacherHours = validateAndBalanceTeacherHours(courseHours, theoryTeachers, saved.teacherHours || c.teacherHours);

        localSubjectMappings[c.code] = {
          hours: courseHours,
          courseType: 'T',
          teachers: theoryTeachers,
          teacherHours: teacherHours,
          practicalHours: 0,
          theoryHours: courseHours,
          theoryTeachers: theoryTeachers,
          theoryTeacherHours: teacherHours,
          practicalTeachers: []
        };
        syncAutoGenConfigForCourse(c.code);
      }
    }
  });

  if (savedSubjectMappingsSnapshot === null) {
    updateSubjectMappingsSnapshot();
  }
}

function renderTileFacultyPopoverHtml(cCode, sectionKey, popoverId, selectedList, deptFaculty, closeClass, filterClass, cbClass) {
  return `
    <div class="fac-checklist-popover hidden mt-2" id="${popoverId}" style="background: #ffffff; border: 1.5px solid var(--primary); border-radius: 6px; padding: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.12);">
      <div style="font-weight: 700; font-size: 11px; margin-bottom: 6px; display: flex; justify-content: space-between;">
        <span>Select Faculty (${deptFaculty.length}):</span>
        <span class="text-muted" style="font-weight: normal; font-size: 10px;">Check 1 or more</span>
      </div>
      ${deptFaculty.length > 5 ? `
        <input type="text" class="form-control form-control-sm ${filterClass} mb-2" data-course-code="${cCode}" placeholder="Filter teachers..." style="font-size: 11px; height: 24px; padding: 2px 6px;">
      ` : ''}
      <div class="tile-fac-checklist" style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px;">
        ${deptFaculty.map(f => {
          const isChecked = selectedList.includes(f.code);
          return `
            <label class="tile-fac-item" style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: 3px;">
              <input type="checkbox" class="${cbClass}" data-course-code="${cCode}" data-fac-code="${f.code}" ${isChecked ? 'checked' : ''} style="accent-color: var(--primary);">
              <strong style="color: var(--primary); min-width: 30px;">${f.code}</strong>
              <span style="color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.name}</span>
            </label>
          `;
        }).join('')}
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 6px; padding-top: 4px; border-top: 1px solid var(--border);">
        <button type="button" class="btn btn-primary btn-xs ${closeClass}" data-course-code="${cCode}" style="font-size: 10px; padding: 2px 10px;">Done</button>
      </div>
    </div>
  `;
}

function populateSubjectMappingSemFilter() {
  const semFilter = document.getElementById('subject-mapping-sem-filter');
  const progFilter = document.getElementById('subject-mapping-program-filter');
  if (!semFilter) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const selectedProg = progFilter ? progFilter.value : '';

  const curVal = semFilter.value;
  semFilter.innerHTML = '<option value="">All Semesters</option>';

  if (selectedProg === 'UG') {
    const sems = Array.from(new Set(deptCourses.filter(c => (c.programType || 'UG') === 'UG').map(c => c.semester))).sort((a,b) => parseInt(a||0) - parseInt(b||0));
    sems.forEach(s => {
      semFilter.innerHTML += `<option value="${s}">Semester ${s} (BSc)</option>`;
    });
  } else if (selectedProg === 'PG') {
    const sems = Array.from(new Set(deptCourses.filter(c => (c.programType || 'UG') === 'PG').map(c => c.semester))).sort((a,b) => parseInt(a||0) - parseInt(b||0));
    sems.forEach(s => {
      semFilter.innerHTML += `<option value="${s}">Semester ${s} (MSc)</option>`;
    });
  } else {
    // All Programs: list each semester and degree clearly
    const pairs = [];
    deptCourses.forEach(c => {
      const prog = c.programType || 'UG';
      const key = `${c.semester}_${prog}`;
      if (!pairs.some(p => p.key === key)) {
        pairs.push({ key, sem: c.semester, prog });
      }
    });
    pairs.sort((a, b) => {
      const semDiff = parseInt(a.sem || 0) - parseInt(b.sem || 0);
      if (semDiff !== 0) return semDiff;
      return a.prog.localeCompare(b.prog);
    });

    pairs.forEach(p => {
      const progLabel = p.prog === 'PG' ? 'MSc' : 'BSc';
      semFilter.innerHTML += `<option value="${p.key}">Semester ${p.sem} (${progLabel})</option>`;
    });
  }

  if (Array.from(semFilter.options).some(o => o.value === curVal)) {
    semFilter.value = curVal;
  }
}

function renderSubjectMappingTiles() {
  const container = document.getElementById('subject-mapping-grid');
  const semFilter = document.getElementById('subject-mapping-sem-filter');
  const progFilter = document.getElementById('subject-mapping-program-filter');
  const searchInput = document.getElementById('subject-mapping-search');
  const sortSelect = document.getElementById('subject-mapping-sort');
  if (!container) return;

  initLocalSubjectMappings();

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  let deptCourses = state.courses.filter(c => c.department === deptName);
  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  // Populate semester filter dropdown if needed
  if (semFilter && semFilter.options.length <= 1) {
    populateSubjectMappingSemFilter();
  }

  // Filter by program
  const selectedProg = progFilter ? progFilter.value : '';
  if (selectedProg) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === selectedProg);
  }

  // Filter by semester (supports simple sem '1' or combined '1_UG' / '1_PG')
  const selectedSem = semFilter ? semFilter.value : '';
  if (selectedSem) {
    if (selectedSem.includes('_')) {
      const [sNum, sProg] = selectedSem.split('_');
      deptCourses = deptCourses.filter(c => String(c.semester) === String(sNum) && (c.programType || 'UG') === sProg);
    } else {
      deptCourses = deptCourses.filter(c => String(c.semester) === String(selectedSem));
    }
  }

  // Filter by search query
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  if (query) {
    deptCourses = deptCourses.filter(c => 
      c.code.toLowerCase().includes(query) || 
      c.name.toLowerCase().includes(query) ||
      (c.alias && c.alias.toLowerCase().includes(query))
    );
  }

  // Sort courses
  const sortMode = sortSelect ? sortSelect.value : 'code-asc';
  deptCourses.sort((a, b) => {
    const mapA = localSubjectMappings[a.code] || { hours: 4, courseType: 'T' };
    const mapB = localSubjectMappings[b.code] || { hours: 4, courseType: 'T' };
    if (sortMode === 'code-asc') return a.code.localeCompare(b.code);
    if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
    if (sortMode === 'sem-asc') return parseInt(a.semester) - parseInt(b.semester);
    if (sortMode === 'hours-desc') return (mapB.hours || 0) - (mapA.hours || 0);
    if (sortMode === 'type') return mapA.courseType.localeCompare(mapB.courseType);
    return 0;
  });

  if (deptCourses.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
        <i class="fa-solid fa-magnifying-glass" style="font-size: 32px; margin-bottom: 10px; color: #cbd5e1;"></i>
        <p>No subjects found matching your search or semester filter.</p>
      </div>
    `;
    return;
  }

  let html = '';
  deptCourses.forEach(c => {
    const mapping = localSubjectMappings[c.code] || {
      hours: parseInt(c.hours) || 4,
      courseType: (c.courseType === 'P' || c.code.endsWith('-P')) ? 'P' : 'T',
      teachers: [],
      teacherHours: {},
      practicalHours: 2,
      theoryHours: 2,
      practicalTeachers: [],
      theoryTeachers: [],
      theoryTeacherHours: {}
    };

    const isPrac = mapping.courseType === 'P';
    const theoryTeachers = mapping.courseType === 'T' ? (mapping.teachers || []) : (mapping.theoryTeachers || []);
    
    // Ensure hours are strictly validated and balanced
    mapping.teacherHours = validateAndBalanceTeacherHours(mapping.hours, theoryTeachers, mapping.teacherHours);
    const theoryTeacherHours = mapping.courseType === 'T' ? mapping.teacherHours : (mapping.theoryTeacherHours || {});
    const practicalTeachers = mapping.practicalTeachers || [];
    const practicalHours = mapping.practicalHours || 2;
    const maxEvenPrac = mapping.hours % 2 === 0 ? mapping.hours : Math.max(2, mapping.hours - 1);

    // Calculate sum of allocated pure theory hours
    const pureTheorySum = theoryTeachers.reduce((acc, t) => acc + (parseInt(theoryTeacherHours[t]) || 0), 0);

    // Calculate sum of practical's theory hours
    if (mapping.theoryTeachers && mapping.theoryTeachers.length > 0) {
      mapping.theoryTeacherHours = validateAndBalanceTeacherHours(mapping.theoryHours || 0, mapping.theoryTeachers, mapping.theoryTeacherHours);
    }
    const pracTheorySum = (mapping.theoryTeachers || []).reduce((acc, t) => acc + (parseInt(mapping.theoryTeacherHours && mapping.theoryTeacherHours[t]) || 0), 0);

    // Theory pills (pure theory)
    const theoryPillsHtml = theoryTeachers.length > 0
      ? theoryTeachers.map(fc => `<span class="teacher-tag-pill">${fc}</span>`).join('')
      : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`;

    // Practical pills
    const pracPillsHtml = practicalTeachers.length > 0
      ? practicalTeachers.map(fc => `<span class="teacher-tag-pill-prac">${fc}</span>`).join('')
      : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`;

    // Theory split rows (pure theory)
    const pureTheorySplitRows = theoryTeachers.map(fc => {
      const fObj = deptFaculty.find(f => f.code === fc);
      const fName = fObj ? fObj.name : fc;
      const curHrs = theoryTeacherHours[fc] !== undefined ? theoryTeacherHours[fc] : Math.max(1, Math.floor(mapping.hours / theoryTeachers.length));
      return `
        <div class="teacher-split-row">
          <div class="teacher-name-info" title="${fName}">
            <strong>${fc}</strong> - <span>${fName}</span>
          </div>
          <div class="teacher-input-wrapper">
            <input type="number" min="1" max="${mapping.hours}" class="form-control form-control-sm teacher-split-input" data-course-code="${c.code}" data-fac-code="${fc}" value="${curHrs}">
            <span style="font-weight: 600;">hrs</span>
          </div>
        </div>
      `;
    }).join('');

    // Practical's theory split rows
    const pracTheorySplitRows = (mapping.theoryTeachers || []).map(fc => {
      const fObj = deptFaculty.find(f => f.code === fc);
      const fName = fObj ? fObj.name : fc;
      const curHrs = (mapping.theoryTeacherHours && mapping.theoryTeacherHours[fc] !== undefined) ? mapping.theoryTeacherHours[fc] : Math.max(1, Math.floor((mapping.theoryHours || mapping.hours) / (mapping.theoryTeachers.length || 1)));
      return `
        <div class="teacher-split-row" style="background: #ffffff;">
          <div class="teacher-name-info" title="${fName}">
            <strong>${fc}</strong> - <span>${fName}</span>
          </div>
          <div class="teacher-input-wrapper">
            <input type="number" min="1" max="${mapping.theoryHours || mapping.hours}" class="form-control form-control-sm prac-theory-split-input" data-course-code="${c.code}" data-fac-code="${fc}" value="${curHrs}">
            <span style="font-weight: 600;">hrs</span>
          </div>
        </div>
      `;
    }).join('');

    html += `
      <div class="subject-tile-card" data-course-code="${c.code}" id="subject-card-${c.code}">
        <!-- Tile Header -->
        <div class="subject-tile-header">
          <div>
            <div class="subject-tile-title">${c.code} <span class="badge badge-info" style="font-size: 10px; margin-left: 4px;">Sem ${c.semester}</span></div>
            <div class="subject-tile-name" title="${c.name}">${c.name}</div>
          </div>
          <span class="badge ${isPrac ? 'badge-success' : 'badge-warning'} tile-category-badge" style="font-size: 11px; font-weight: 700;">
            ${isPrac ? 'Practical (PR)' : 'Theory (TH)'}
          </span>
        </div>

        <!-- 1. Weekly Total Hours -->
        <div class="subject-tile-section">
          <label class="subject-tile-label"><i class="fa-solid fa-clock text-primary"></i> 1. Weekly Total Hours</label>
          <div class="flex-row items-center gap-2">
            <input type="number" min="1" max="15" class="form-control form-control-sm input-course-total-hours" data-course-code="${c.code}" value="${mapping.hours}" style="font-weight: 700; width: 75px; text-align: center; font-size: 13px;">
            <span class="text-muted text-sm" style="font-size: 11px;">Hours / Week</span>
          </div>
        </div>

        <!-- 2. Teaching Category Selection (Theory vs Practical) -->
        <div class="subject-tile-section">
          <label class="subject-tile-label"><i class="fa-solid fa-book-open text-primary"></i> 2. Teaching Category</label>
          <div class="flex-row items-center gap-4 mt-1">
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">
              <input type="radio" name="tile-type-${c.code}" class="tile-type-radio" data-course-code="${c.code}" value="T" ${!isPrac ? 'checked' : ''} style="accent-color: var(--primary);">
              <span>Theory</span>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">
              <input type="radio" name="tile-type-${c.code}" class="tile-type-radio" data-course-code="${c.code}" value="P" ${isPrac ? 'checked' : ''} style="accent-color: #16a34a;">
              <span>Practical</span>
            </label>
          </div>
        </div>

        <!-- BRANCH A: THEORY SECTION -->
        <div class="tile-theory-branch" id="tile-theory-branch-${c.code}" style="display: ${!isPrac ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
          <!-- 3. Assign Theory Teachers -->
          <div class="subject-tile-section">
            <div class="flex-row justify-between items-center">
              <span class="subject-tile-label"><i class="fa-solid fa-chalkboard-user text-primary"></i> 3. Theory Teachers</span>
              <button type="button" class="btn btn-outline btn-xs btn-open-fac-picker" data-course-code="${c.code}" data-section="pure-theory" style="font-size: 10px; padding: 2px 8px;">
                <i class="fa-solid fa-user-plus"></i> Select Teachers
              </button>
            </div>
            <div class="flex-row gap-1 flex-wrap mt-1" id="tile-fac-pills-${c.code}">
              ${theoryPillsHtml}
            </div>

            ${renderTileFacultyPopoverHtml(c.code, 'pure-theory', `tile-popover-${c.code}`, theoryTeachers, deptFaculty, 'btn-close-tile-popover', 'tile-fac-filter', 'tile-teacher-cb')}
          </div>

          <!-- Per-Teacher Hours Allotment -->
          <div class="subject-tile-section tile-teacher-split-container" id="tile-split-${c.code}" style="display: ${theoryTeachers.length > 0 ? 'flex' : 'none'}; width: 100%;">
            <div class="flex-row justify-between items-center" style="width: 100%; margin-bottom: 2px;">
              <label class="subject-tile-label"><i class="fa-solid fa-sliders text-success"></i> Hours Allotment Per Teacher</label>
              <div class="flex-row items-center gap-1">
                <span class="badge ${pureTheorySum === mapping.hours ? 'badge-success' : 'badge-danger'}" id="tile-split-badge-${c.code}" style="font-size: 10px;">
                  ${pureTheorySum === mapping.hours ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-triangle-exclamation"></i>'} Total: ${pureTheorySum} / ${mapping.hours} hrs
                </span>
                <button type="button" class="btn btn-outline btn-xs btn-auto-balance-pure" data-course-code="${c.code}" style="font-size: 10px; padding: 1px 5px;" title="Rebalance equal split">
                  <i class="fa-solid fa-scale-balanced"></i>
                </button>
              </div>
            </div>
            <div class="teacher-split-rows-container" id="tile-split-rows-${c.code}">
              ${pureTheorySplitRows}
            </div>
          </div>
        </div>

        <!-- BRANCH B: PRACTICAL SECTION -->
        <div class="tile-practical-branch" id="tile-practical-branch-${c.code}" style="display: ${isPrac ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
          <!-- Practical & Theory Hours Breakdown Box -->
          <div class="practical-breakdown-box">
            <div style="font-weight: 700; color: #166534; font-size: 11px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
              <span><i class="fa-solid fa-flask"></i> Practical & Theory Hours Breakdown:</span>
              <span class="badge badge-success" style="font-size: 9px; padding: 1px 5px;">Even Practical Hours</span>
            </div>
            <div class="flex-row items-center gap-3">
              <div style="flex: 1;">
                <label style="display: block; font-size: 10px; font-weight: 700; color: #15803d; margin-bottom: 2px;">
                  Practical Hours <span style="font-size: 9px; font-weight: normal;">(Even: 2, 4...)</span>
                </label>
                <input type="number" min="2" max="${maxEvenPrac}" step="2" class="form-control form-control-sm tile-input-prac-hours" data-course-code="${c.code}" value="${practicalHours}" style="width: 100%; text-align: center; font-weight: 700;">
              </div>
              <div style="flex: 1;">
                <label style="display: block; font-size: 10px; font-weight: 700; color: #15803d; margin-bottom: 2px;">
                  Theory Hours <span style="font-size: 9px; font-weight: normal;">(Remaining)</span>
                </label>
                <input type="number" min="0" max="${mapping.hours}" class="form-control form-control-sm tile-input-theory-hours" data-course-code="${c.code}" value="${mapping.theoryHours || 0}" style="width: 100%; text-align: center; font-weight: 700;">
              </div>
            </div>
          </div>

          <!-- Practical Section: Lab Teachers (Co-teaching) -->
          <div class="practical-teachers-box" id="tile-prac-fac-box-${c.code}" style="display: ${practicalHours > 0 ? 'block' : 'none'};">
            <div class="flex-row justify-between items-center mb-1">
              <span style="font-size: 11px; font-weight: 700; color: #166534;">
                <i class="fa-solid fa-users text-success"></i> Practical Teachers (${practicalHours} hrs)
              </span>
              <button type="button" class="btn btn-outline btn-xs btn-open-fac-picker" data-course-code="${c.code}" data-section="practical" style="font-size: 10px; padding: 2px 8px; border-color: #86efac; color: #166534;">
                <i class="fa-solid fa-user-plus"></i> Select Practical Teachers
              </button>
            </div>

            <div class="flex-row gap-1 flex-wrap mt-1" id="tile-prac-fac-pills-${c.code}">
              ${pracPillsHtml}
            </div>

            <div class="coteach-notice mt-2">
              <i class="fa-solid fa-circle-info" style="font-size: 11px;"></i>
              <span><strong>Co-Teaching:</strong> All assigned practical teachers teach together in the same class and period (hours are not split). Both teachers appear in the schedule.</span>
            </div>

            ${renderTileFacultyPopoverHtml(c.code, 'practical', `tile-prac-popover-${c.code}`, practicalTeachers, deptFaculty, 'btn-close-tile-popover', 'tile-fac-filter-prac', 'tile-teacher-cb-prac')}
          </div>

          <!-- Theory Section for Practical Course -->
          <div class="practical-theory-box" id="tile-prac-theory-box-${c.code}" style="display: ${(mapping.theoryHours || 0) > 0 ? 'block' : 'none'};">
            <div class="flex-row justify-between items-center mb-1">
              <span style="font-size: 11px; font-weight: 700; color: #1e40af;">
                <i class="fa-solid fa-book text-primary"></i> Theory Teachers (${mapping.theoryHours || 0} hrs)
              </span>
              <button type="button" class="btn btn-outline btn-xs btn-open-fac-picker" data-course-code="${c.code}" data-section="prac-theory" style="font-size: 10px; padding: 2px 8px; border-color: #93c5fd; color: #1e40af;">
                <i class="fa-solid fa-user-plus"></i> Select Theory Teachers
              </button>
            </div>

            <div class="flex-row gap-1 flex-wrap mt-1" id="tile-prac-theory-pills-${c.code}">
              ${(mapping.theoryTeachers && mapping.theoryTeachers.length > 0)
                ? mapping.theoryTeachers.map(fc => `<span class="teacher-tag-pill">${fc}</span>`).join('')
                : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`}
            </div>

            ${renderTileFacultyPopoverHtml(c.code, 'prac-theory', `tile-prac-theory-popover-${c.code}`, (mapping.theoryTeachers || []), deptFaculty, 'btn-close-tile-popover', 'tile-fac-filter-prac-theory', 'tile-teacher-cb-prac-theory')}

            <div class="tile-prac-theory-split-container mt-2" id="tile-prac-theory-split-${c.code}" style="display: ${(mapping.theoryTeachers && mapping.theoryTeachers.length > 0) ? 'block' : 'none'}; width: 100%;">
              <div class="flex-row justify-between items-center" style="width: 100%; margin-bottom: 2px;">
                <label style="font-size: 10px; font-weight: 700; color: #1e40af;"><i class="fa-solid fa-sliders"></i> Theory Hours Allotment</label>
                <div class="flex-row items-center gap-1">
                  <span class="badge ${pracTheorySum === (mapping.theoryHours || 0) ? 'badge-success' : 'badge-danger'}" id="tile-prac-theory-split-badge-${c.code}" style="font-size: 10px;">
                    ${pracTheorySum === (mapping.theoryHours || 0) ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-triangle-exclamation"></i>'} Total: ${pracTheorySum} / ${mapping.theoryHours || 0} hrs
                  </span>
                  <button type="button" class="btn btn-outline btn-xs btn-auto-balance-prac-theory" data-course-code="${c.code}" style="font-size: 10px; padding: 1px 5px;" title="Rebalance equal split">
                    <i class="fa-solid fa-scale-balanced"></i>
                  </button>
                </div>
              </div>
              <div class="teacher-split-rows-container" id="tile-prac-theory-split-rows-${c.code}">
                ${pracTheorySplitRows}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  bindSubjectMappingTileEvents(container, deptFaculty);
}

function renderPureTheorySplitRows(container, cCode, deptFaculty) {
  const splitContainer = document.getElementById(`tile-split-${cCode}`);
  const splitRows = document.getElementById(`tile-split-rows-${cCode}`);
  if (!splitContainer || !splitRows) return;
  const mapping = localSubjectMappings[cCode] || {};
  const teachers = mapping.teachers || [];
  if (teachers.length === 0) {
    splitContainer.style.display = 'none';
    splitRows.innerHTML = '';
    return;
  }
  splitContainer.style.display = 'flex';
  mapping.teacherHours = validateAndBalanceTeacherHours(mapping.hours, teachers, mapping.teacherHours);
  const thHours = mapping.teacherHours || {};
  splitRows.innerHTML = teachers.map(fc => {
    const fObj = deptFaculty.find(f => f.code === fc);
    const fName = fObj ? fObj.name : fc;
    const curHrs = thHours[fc] !== undefined ? thHours[fc] : Math.max(1, Math.floor(mapping.hours / teachers.length));
    return `
      <div class="teacher-split-row">
        <div class="teacher-name-info" title="${fName}">
          <strong>${fc}</strong> - <span>${fName}</span>
        </div>
        <div class="teacher-input-wrapper">
          <input type="number" min="1" max="${mapping.hours}" class="form-control form-control-sm teacher-split-input" data-course-code="${cCode}" data-fac-code="${fc}" value="${curHrs}">
          <span style="font-weight: 600;">hrs</span>
        </div>
      </div>
    `;
  }).join('');
  updateSplitBadge(cCode, mapping.hours, thHours, `tile-split-badge-${cCode}`);
  bindSplitInputListeners(splitRows, cCode);
}

function renderPracTheorySplitRows(container, cCode, deptFaculty) {
  const splitContainer = document.getElementById(`tile-prac-theory-split-${cCode}`);
  const splitRows = document.getElementById(`tile-prac-theory-split-rows-${cCode}`);
  if (!splitContainer || !splitRows) return;
  const mapping = localSubjectMappings[cCode] || {};
  const teachers = mapping.theoryTeachers || [];
  if (teachers.length === 0) {
    splitContainer.style.display = 'none';
    splitRows.innerHTML = '';
    return;
  }
  splitContainer.style.display = 'block';
  const thTarget = mapping.theoryHours || mapping.hours;
  mapping.theoryTeacherHours = validateAndBalanceTeacherHours(thTarget, teachers, mapping.theoryTeacherHours);
  const thHours = mapping.theoryTeacherHours || {};
  splitRows.innerHTML = teachers.map(fc => {
    const fObj = deptFaculty.find(f => f.code === fc);
    const fName = fObj ? fObj.name : fc;
    const curHrs = thHours[fc] !== undefined ? thHours[fc] : Math.max(1, Math.floor(thTarget / teachers.length));
    return `
      <div class="teacher-split-row" style="background: #ffffff;">
        <div class="teacher-name-info" title="${fName}">
          <strong>${fc}</strong> - <span>${fName}</span>
        </div>
        <div class="teacher-input-wrapper">
          <input type="number" min="1" max="${thTarget}" class="form-control form-control-sm prac-theory-split-input" data-course-code="${cCode}" data-fac-code="${fc}" value="${curHrs}">
          <span style="font-weight: 600;">hrs</span>
        </div>
      </div>
    `;
  }).join('');
  updateSplitBadge(cCode, thTarget, thHours, `tile-prac-theory-split-badge-${cCode}`);
  bindPracTheorySplitInputListeners(splitRows, cCode);
}

function syncAutoGenConfigForCourse(cCode) {
  const mData = localSubjectMappings[cCode];
  if (!mData) return;
  if (mData.courseType === 'P') {
    const unified = Array.from(new Set([...(mData.practicalTeachers || []), ...(mData.theoryTeachers || [])]));
    autoGenCourseFacultyBindings[cCode] = unified;
    autoGenCourseFacultyConfig[cCode] = {
      teachers: unified,
      distribute: false,
      teacherHours: mData.teacherHours || {},
      courseType: 'P',
      practicalHours: mData.practicalHours,
      theoryHours: mData.theoryHours,
      practicalTeachers: mData.practicalTeachers || [],
      theoryTeachers: mData.theoryTeachers || [],
      theoryTeacherHours: mData.theoryTeacherHours || {}
    };
  } else {
    autoGenCourseFacultyBindings[cCode] = mData.teachers || [];
    autoGenCourseFacultyConfig[cCode] = {
      teachers: mData.teachers || [],
      distribute: (mData.teachers && mData.teachers.length > 1),
      teacherHours: mData.teacherHours || {},
      courseType: 'T',
      practicalHours: 0,
      theoryHours: mData.hours,
      practicalTeachers: [],
      theoryTeachers: mData.teachers || [],
      theoryTeacherHours: mData.teacherHours || {}
    };
  }
}

function bindSubjectMappingTileEvents(container, deptFaculty) {
  // Toggle Faculty Picker Popovers
  container.querySelectorAll('.btn-open-fac-picker').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const section = btn.getAttribute('data-section');
      let popoverId = `tile-popover-${cCode}`;
      if (section === 'practical') popoverId = `tile-prac-popover-${cCode}`;
      else if (section === 'prac-theory') popoverId = `tile-prac-theory-popover-${cCode}`;

      const popover = document.getElementById(popoverId);
      if (!popover) return;
      const isHidden = popover.classList.contains('hidden');
      container.querySelectorAll('.fac-checklist-popover').forEach(p => p.classList.add('hidden'));
      if (isHidden) popover.classList.remove('hidden');
    });
  });

  // Close Popovers
  container.querySelectorAll('.btn-close-tile-popover').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = btn.closest('.fac-checklist-popover');
      if (popover) popover.classList.add('hidden');
    });
  });

  // Auto-Balance Buttons
  container.querySelectorAll('.btn-auto-balance-pure').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const totalHrs = (localSubjectMappings[cCode] && localSubjectMappings[cCode].hours) || 4;
      const teachers = (localSubjectMappings[cCode] && localSubjectMappings[cCode].teachers) || [];
      if (teachers.length > 0) {
        localSubjectMappings[cCode].teacherHours = calculateDefaultTeacherSplit(totalHrs, teachers);
        localSubjectMappings[cCode].theoryTeacherHours = localSubjectMappings[cCode].teacherHours;
        renderPureTheorySplitRows(container, cCode, deptFaculty);
        syncAutoGenConfigForCourse(cCode);
      }
    });
  });

  container.querySelectorAll('.btn-auto-balance-prac-theory').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const theoryHrs = (localSubjectMappings[cCode] && localSubjectMappings[cCode].theoryHours) || 0;
      const teachers = (localSubjectMappings[cCode] && localSubjectMappings[cCode].theoryTeachers) || [];
      if (teachers.length > 0) {
        localSubjectMappings[cCode].theoryTeacherHours = calculateDefaultTeacherSplit(theoryHrs, teachers);
        renderPracTheorySplitRows(container, cCode, deptFaculty);
        syncAutoGenConfigForCourse(cCode);
      }
    });
  });

  // Filters inside popovers
  ['.tile-fac-filter', '.tile-fac-filter-prac', '.tile-fac-filter-prac-theory'].forEach(cls => {
    container.querySelectorAll(cls).forEach(input => {
      input.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        const popover = input.closest('.fac-checklist-popover');
        if (!popover) return;
        popover.querySelectorAll('.tile-fac-item').forEach(item => {
          const text = item.innerText.toLowerCase();
          item.style.display = text.includes(q) ? 'flex' : 'none';
        });
      });
    });
  });

  // Pure Theory Teacher Checkbox Changes
  container.querySelectorAll('.tile-teacher-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      const popover = document.getElementById(`tile-popover-${cCode}`);
      if (!popover) return;
      const checkedBoxes = Array.from(popover.querySelectorAll('.tile-teacher-cb:checked'));
      const selected = checkedBoxes.map(b => b.getAttribute('data-fac-code'));

      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].teachers = selected;
      localSubjectMappings[cCode].theoryTeachers = selected;

      // Update pills
      const pillsContainer = document.getElementById(`tile-fac-pills-${cCode}`);
      if (pillsContainer) {
        pillsContainer.innerHTML = selected.length > 0
          ? selected.map(fc => `<span class="teacher-tag-pill">${fc}</span>`).join('')
          : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`;
      }

      // Default equal split
      localSubjectMappings[cCode].teacherHours = calculateDefaultTeacherSplit(localSubjectMappings[cCode].hours, selected);
      localSubjectMappings[cCode].theoryTeacherHours = localSubjectMappings[cCode].teacherHours;
      renderPureTheorySplitRows(container, cCode, deptFaculty);
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Practical Teacher Checkbox Changes (Co-teaching, no hour split!)
  container.querySelectorAll('.tile-teacher-cb-prac').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      const popover = document.getElementById(`tile-prac-popover-${cCode}`);
      if (!popover) return;
      const checkedBoxes = Array.from(popover.querySelectorAll('.tile-teacher-cb-prac:checked'));
      const selected = checkedBoxes.map(b => b.getAttribute('data-fac-code'));

      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].practicalTeachers = selected;

      // Update practical pills
      const pillsContainer = document.getElementById(`tile-prac-fac-pills-${cCode}`);
      if (pillsContainer) {
        pillsContainer.innerHTML = selected.length > 0
          ? selected.map(fc => `<span class="teacher-tag-pill-prac">${fc}</span>`).join('')
          : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`;
      }

      // Update unified teachers
      const unified = Array.from(new Set([...selected, ...(localSubjectMappings[cCode].theoryTeachers || [])]));
      localSubjectMappings[cCode].teachers = unified;
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Practical Course's Theory Teacher Checkbox Changes
  container.querySelectorAll('.tile-teacher-cb-prac-theory').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      const popover = document.getElementById(`tile-prac-theory-popover-${cCode}`);
      if (!popover) return;
      const checkedBoxes = Array.from(popover.querySelectorAll('.tile-teacher-cb-prac-theory:checked'));
      const selected = checkedBoxes.map(b => b.getAttribute('data-fac-code'));

      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].theoryTeachers = selected;

      // Update pills
      const pillsContainer = document.getElementById(`tile-prac-theory-pills-${cCode}`);
      if (pillsContainer) {
        pillsContainer.innerHTML = selected.length > 0
          ? selected.map(fc => `<span class="teacher-tag-pill">${fc}</span>`).join('')
          : `<span class="text-muted text-sm" style="font-size: 11px;">No teachers assigned</span>`;
      }

      // Default equal split of theory hours
      const thHours = localSubjectMappings[cCode].theoryHours || 0;
      localSubjectMappings[cCode].theoryTeacherHours = calculateDefaultTeacherSplit(thHours, selected);
      renderPracTheorySplitRows(container, cCode, deptFaculty);

      // Update unified teachers
      const unified = Array.from(new Set([...(localSubjectMappings[cCode].practicalTeachers || []), ...selected]));
      localSubjectMappings[cCode].teachers = unified;
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Step 1: Total Hours Input Change
  container.querySelectorAll('.input-course-total-hours').forEach(input => {
    input.addEventListener('change', () => {
      const cCode = input.getAttribute('data-course-code');
      const val = Math.max(1, parseInt(input.value) || 4);
      input.value = val;
      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].hours = val;

      if (localSubjectMappings[cCode].courseType === 'P') {
        const defSplit = calculateDefaultPracticalSplit(val);
        let pVal = localSubjectMappings[cCode].practicalHours;
        if (pVal === undefined || pVal % 2 !== 0 || pVal > val) {
          pVal = defSplit.practical;
        }
        if (pVal < 2 && val >= 2) pVal = 2;
        const tVal = Math.max(0, val - pVal);
        localSubjectMappings[cCode].practicalHours = pVal;
        localSubjectMappings[cCode].theoryHours = tVal;

        const pracInput = container.querySelector(`.tile-input-prac-hours[data-course-code="${cCode}"]`);
        const theoryInput = container.querySelector(`.tile-input-theory-hours[data-course-code="${cCode}"]`);
        if (pracInput) {
          pracInput.max = val % 2 === 0 ? val : Math.max(2, val - 1);
          pracInput.value = pVal;
        }
        if (theoryInput) {
          theoryInput.max = val;
          theoryInput.value = tVal;
        }

        // Update practical section & theory section visibility and headers
        const pracBox = document.getElementById(`tile-prac-fac-box-${cCode}`);
        if (pracBox) {
          pracBox.style.display = pVal > 0 ? 'block' : 'none';
          const headerSpan = pracBox.querySelector('span');
          if (headerSpan) headerSpan.innerHTML = `<i class="fa-solid fa-users text-success"></i> Practical Teachers (${pVal} hrs)`;
        }
        const thBox = document.getElementById(`tile-prac-theory-box-${cCode}`);
        if (thBox) {
          thBox.style.display = tVal > 0 ? 'block' : 'none';
          const headerSpan = thBox.querySelector('span');
          if (headerSpan) headerSpan.innerHTML = `<i class="fa-solid fa-book text-primary"></i> Theory Teachers (${tVal} hrs)`;
        }

        // Re-split theory hours among theory teachers
        const thTeachers = localSubjectMappings[cCode].theoryTeachers || [];
        if (thTeachers.length > 0) {
          localSubjectMappings[cCode].theoryTeacherHours = calculateDefaultTeacherSplit(tVal, thTeachers);
          renderPracTheorySplitRows(container, cCode, deptFaculty);
        }
      } else {
        // Pure theory: re-split among theory teachers
        const teachers = localSubjectMappings[cCode].teachers || [];
        if (teachers.length > 0) {
          localSubjectMappings[cCode].teacherHours = calculateDefaultTeacherSplit(val, teachers);
          renderPureTheorySplitRows(container, cCode, deptFaculty);
        }
      }
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Step 2: Theory vs Practical Radio Change
  container.querySelectorAll('.tile-type-radio').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const cCode = radio.getAttribute('data-course-code');
      const isPractical = radio.value === 'P';
      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].courseType = isPractical ? 'P' : 'T';

      const theoryBranch = document.getElementById(`tile-theory-branch-${cCode}`);
      const practicalBranch = document.getElementById(`tile-practical-branch-${cCode}`);
      if (theoryBranch) theoryBranch.style.display = !isPractical ? 'flex' : 'none';
      if (practicalBranch) practicalBranch.style.display = isPractical ? 'flex' : 'none';

      const card = document.getElementById(`subject-card-${cCode}`);
      const typeBadge = card ? card.querySelector('.tile-category-badge') : null;
      if (typeBadge) {
        if (isPractical) {
          typeBadge.className = 'badge badge-success tile-category-badge';
          typeBadge.textContent = 'Practical (PR)';
        } else {
          typeBadge.className = 'badge badge-warning tile-category-badge';
          typeBadge.textContent = 'Theory (TH)';
        }
      }

      if (isPractical) {
        const totalHrs = localSubjectMappings[cCode].hours || 4;
        if (!localSubjectMappings[cCode].practicalHours || localSubjectMappings[cCode].practicalHours % 2 !== 0) {
          const defSplit = calculateDefaultPracticalSplit(totalHrs);
          localSubjectMappings[cCode].practicalHours = defSplit.practical;
          localSubjectMappings[cCode].theoryHours = defSplit.theory;
        }
      }
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Practical Breakdown Hours Inputs (Enforce even numbers for practical)
  container.querySelectorAll('.tile-input-prac-hours').forEach(input => {
    input.addEventListener('change', () => {
      const cCode = input.getAttribute('data-course-code');
      const totalHrs = (localSubjectMappings[cCode] && localSubjectMappings[cCode].hours) || 4;
      let pVal = parseInt(input.value) || 2;
      // Strictly enforce even numbers
      if (pVal % 2 !== 0) {
        pVal = Math.max(2, pVal - 1);
      }
      const maxEven = totalHrs % 2 === 0 ? totalHrs : Math.max(2, totalHrs - 1);
      pVal = Math.max(2, Math.min(maxEven, pVal));
      input.value = pVal;

      const tVal = Math.max(0, totalHrs - pVal);
      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].practicalHours = pVal;
      localSubjectMappings[cCode].theoryHours = tVal;

      const theoryInput = container.querySelector(`.tile-input-theory-hours[data-course-code="${cCode}"]`);
      if (theoryInput) theoryInput.value = tVal;

      // Update practical & theory boxes
      const pracBox = document.getElementById(`tile-prac-fac-box-${cCode}`);
      if (pracBox) {
        pracBox.style.display = pVal > 0 ? 'block' : 'none';
        const headerSpan = pracBox.querySelector('span');
        if (headerSpan) headerSpan.innerHTML = `<i class="fa-solid fa-users text-success"></i> Practical Teachers (${pVal} hrs)`;
      }
      const thBox = document.getElementById(`tile-prac-theory-box-${cCode}`);
      if (thBox) {
        thBox.style.display = tVal > 0 ? 'block' : 'none';
        const headerSpan = thBox.querySelector('span');
        if (headerSpan) headerSpan.innerHTML = `<i class="fa-solid fa-book text-primary"></i> Theory Teachers (${tVal} hrs)`;
      }

      // Re-split theory hours among theory teachers
      const thTeachers = localSubjectMappings[cCode].theoryTeachers || [];
      if (thTeachers.length > 0) {
        localSubjectMappings[cCode].theoryTeacherHours = calculateDefaultTeacherSplit(tVal, thTeachers);
        renderPracTheorySplitRows(container, cCode, deptFaculty);
      }
      syncAutoGenConfigForCourse(cCode);
    });
  });

  container.querySelectorAll('.tile-input-theory-hours').forEach(input => {
    input.addEventListener('change', () => {
      const cCode = input.getAttribute('data-course-code');
      const totalHrs = (localSubjectMappings[cCode] && localSubjectMappings[cCode].hours) || 4;
      let tVal = Math.max(0, Math.min(totalHrs, parseInt(input.value) || 0));
      let pVal = totalHrs - tVal;
      // Ensure practical remains even
      if (pVal % 2 !== 0) {
        pVal = Math.max(2, pVal - 1);
        tVal = totalHrs - pVal;
      }
      input.value = tVal;

      const pracInput = container.querySelector(`.tile-input-prac-hours[data-course-code="${cCode}"]`);
      if (pracInput) pracInput.value = pVal;

      if (!localSubjectMappings[cCode]) localSubjectMappings[cCode] = {};
      localSubjectMappings[cCode].theoryHours = tVal;
      localSubjectMappings[cCode].practicalHours = pVal;

      // Re-split theory hours among theory teachers
      const thTeachers = localSubjectMappings[cCode].theoryTeachers || [];
      if (thTeachers.length > 0) {
        localSubjectMappings[cCode].theoryTeacherHours = calculateDefaultTeacherSplit(tVal, thTeachers);
        renderPracTheorySplitRows(container, cCode, deptFaculty);
      }
      syncAutoGenConfigForCourse(cCode);
    });
  });

  // Bind initial split inputs
  container.querySelectorAll('.tile-teacher-split-container').forEach(splitContainer => {
    const cCode = splitContainer.id.replace('tile-split-', '');
    bindSplitInputListeners(splitContainer, cCode);
  });
  container.querySelectorAll('.tile-prac-theory-split-container').forEach(splitContainer => {
    const cCode = splitContainer.id.replace('tile-prac-theory-split-', '');
    bindPracTheorySplitInputListeners(splitContainer, cCode);
  });
}

function bindSplitInputListeners(container, cCode) {
  container.querySelectorAll('.teacher-split-input').forEach(input => {
    input.addEventListener('change', () => {
      const facCode = input.getAttribute('data-fac-code');
      const totalHours = (localSubjectMappings[cCode] && localSubjectMappings[cCode].hours) || 4;
      const teachers = (localSubjectMappings[cCode] && localSubjectMappings[cCode].teachers) || [];
      
      let val = parseInt(input.value) || 1;
      // If 2 teachers, automatically adjust the other teacher so sum ALWAYS matches totalHours!
      if (teachers.length === 2) {
        val = Math.max(1, Math.min(totalHours - 1, val));
        input.value = val;
        const otherFac = teachers.find(f => f !== facCode);
        const otherVal = Math.max(1, totalHours - val);
        
        if (!localSubjectMappings[cCode].teacherHours) localSubjectMappings[cCode].teacherHours = {};
        localSubjectMappings[cCode].teacherHours[facCode] = val;
        localSubjectMappings[cCode].teacherHours[otherFac] = otherVal;
        
        const otherInput = container.querySelector(`.teacher-split-input[data-course-code="${cCode}"][data-fac-code="${otherFac}"]`);
        if (otherInput) otherInput.value = otherVal;
      } else {
        val = Math.max(1, Math.min(totalHours, val));
        input.value = val;
        if (!localSubjectMappings[cCode].teacherHours) localSubjectMappings[cCode].teacherHours = {};
        localSubjectMappings[cCode].teacherHours[facCode] = val;
      }

      updateSplitBadge(cCode, totalHours, localSubjectMappings[cCode].teacherHours, `tile-split-badge-${cCode}`);
      syncAutoGenConfigForCourse(cCode);
    });
  });
}

function bindPracTheorySplitInputListeners(container, cCode) {
  container.querySelectorAll('.prac-theory-split-input').forEach(input => {
    input.addEventListener('change', () => {
      const facCode = input.getAttribute('data-fac-code');
      const theoryHours = (localSubjectMappings[cCode] && localSubjectMappings[cCode].theoryHours) || 0;
      const teachers = (localSubjectMappings[cCode] && localSubjectMappings[cCode].theoryTeachers) || [];
      
      let val = parseInt(input.value) || 1;
      // If 2 teachers, automatically adjust the other teacher so sum ALWAYS matches theoryHours!
      if (teachers.length === 2) {
        val = Math.max(1, Math.min(Math.max(1, theoryHours - 1), val));
        input.value = val;
        const otherFac = teachers.find(f => f !== facCode);
        const otherVal = Math.max(1, theoryHours - val);
        
        if (!localSubjectMappings[cCode].theoryTeacherHours) localSubjectMappings[cCode].theoryTeacherHours = {};
        localSubjectMappings[cCode].theoryTeacherHours[facCode] = val;
        localSubjectMappings[cCode].theoryTeacherHours[otherFac] = otherVal;
        
        const otherInput = container.querySelector(`.prac-theory-split-input[data-course-code="${cCode}"][data-fac-code="${otherFac}"]`);
        if (otherInput) otherInput.value = otherVal;
      } else {
        val = Math.max(1, Math.min(theoryHours, val));
        input.value = val;
        if (!localSubjectMappings[cCode].theoryTeacherHours) localSubjectMappings[cCode].theoryTeacherHours = {};
        localSubjectMappings[cCode].theoryTeacherHours[facCode] = val;
      }

      updateSplitBadge(cCode, theoryHours, localSubjectMappings[cCode].theoryTeacherHours, `tile-prac-theory-split-badge-${cCode}`);
      syncAutoGenConfigForCourse(cCode);
    });
  });
}

async function saveAllSubjectMappings() {
  if (isTimetableLocked()) {
    showModalAlert('Timetable Locked', 'Modifications to subject mappings are disabled while timetable is locked.', 'warning');
    return;
  }

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const btnSave = document.getElementById('btn-save-subject-mapping');
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving Mappings...`;
  }

  try {
    const res = await authFetch(`${API_BASE}/department/subject-mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        mappings: localSubjectMappings
      })
    });

    const result = await res.json();
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = `<i class="fa-solid fa-save"></i> Save All Subject Mappings`;
    }

    if (res.ok && result.success) {
      if (!state.subjectTeacherMapping) state.subjectTeacherMapping = {};
      state.subjectTeacherMapping[deptName.toUpperCase()] = JSON.parse(JSON.stringify(localSubjectMappings));

      // Sync local courses state
      Object.entries(localSubjectMappings).forEach(([cCode, mData]) => {
        const course = state.courses.find(c => c.code === cCode);
        if (course) {
          course.hours = mData.hours;
          course.courseType = mData.courseType;
          course.practicalHours = mData.practicalHours;
          course.theoryHours = mData.theoryHours;
          course.teachers = mData.teachers;
          course.teacherHours = mData.teacherHours;
          course.practicalTeachers = mData.practicalTeachers;
          course.theoryTeachers = mData.theoryTeachers;
          course.theoryTeacherHours = mData.theoryTeacherHours;
        }

        // Sync to auto-gen structures
        syncAutoGenConfigForCourse(cCode);
      });

      updateSubjectMappingsSnapshot();
      showModalAlert('Saved', 'Subject teacher mappings, weekly hours, and course types saved successfully!', 'success');
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
    } else {
      showModalAlert('Error', result.message || 'Failed to save subject mappings.', 'danger');
    }
  } catch (err) {
    console.error(err);
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = `<i class="fa-solid fa-save"></i> Save All Subject Mappings`;
    }
    showModalAlert('Error', 'Connection error while saving subject mappings.', 'danger');
  }
}

// -------------------------------------------------------------
// TAB: Common Subject Mapping & Locked Period Inspection
// -------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COMMON_SUBJECT_DEFINITIONS = [
  // Semester 1
  {
    code: 'AEC1',
    name: 'Ability Enhancement Course 1 (AEC1)',
    semester: '1',
    departments: ['ENGLISH'],
    desc: 'Offered exclusively by English Department for Semester 1 students.'
  },
  {
    code: 'AEC2',
    name: 'Ability Enhancement Course 2 (AEC2)',
    semester: '1',
    departments: ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'],
    desc: 'Language & Ability course for Semester 1 students across Malayalam, English, Hindi, and Sanskrit.'
  },
  {
    code: 'MDC1',
    name: 'Multi-Disciplinary Course 1 (MDC1)',
    semester: '1',
    departments: 'ALL',
    desc: 'Institution-wide multidisciplinary course for all Semester 1 students across all departments.'
  },
  // Semester 2
  {
    code: 'AEC3',
    name: 'Ability Enhancement Course 3 (AEC3)',
    semester: '2',
    departments: ['ENGLISH'],
    desc: 'Offered exclusively by English Department for Semester 2 students.'
  },
  {
    code: 'AEC4',
    name: 'Ability Enhancement Course 4 (AEC4)',
    semester: '2',
    departments: ['ENGLISH', 'MALAYALAM', 'HINDI', 'SANSKRIT'],
    desc: 'Language & Ability course for Semester 2 students across English, Malayalam, Hindi, and Sanskrit.'
  },
  {
    code: 'MDC-2',
    name: 'Multi-Disciplinary Course 2 (MDC-2)',
    semester: '2',
    departments: 'ALL',
    desc: 'Institution-wide multidisciplinary course for all Semester 2 students across all departments.'
  },
  // Semester 3
  {
    code: 'VAC1',
    name: 'Value Addition Course 1 (VAC1)',
    semester: '3',
    departments: ['ENGLISH'],
    desc: 'Value Addition Course for Semester 3 students, offered by English Department.'
  },
  {
    code: 'MDC3',
    name: 'Multi-Disciplinary Course 3 (MDC3)',
    semester: '3',
    departments: ['ENGLISH'],
    desc: 'Multi-Disciplinary Course for Semester 3 students, offered by English Department.'
  },
  // Semester 4
  {
    code: 'VAC2',
    name: 'Value Addition Course 2 (VAC2)',
    semester: '4',
    departments: ['ENGLISH'],
    desc: 'Value Addition Course for Semester 4 students, offered by English Department.'
  },
  {
    code: 'SEC',
    name: 'Skill Enhancement Course (SEC)',
    semester: '4',
    departments: ['ENGLISH'],
    desc: 'Skill Enhancement Course for Semester 4 students, offered by English Department.'
  },
  {
    code: 'VAC3',
    name: 'Value Addition Course 3 (VAC3)',
    semester: '4',
    departments: ['MALAYALAM', 'ENGLISH', 'HINDI', 'SANSKRIT'],
    desc: 'Value Addition Course for Semester 4 students across Malayalam, English, Hindi, and Sanskrit.'
  }
];

let selectedCommonSubjectCode = null;

function getVisibleCommonSubjects() {
  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').trim().toUpperCase();
  return COMMON_SUBJECT_DEFINITIONS.filter(def => {
    if (def.departments === 'ALL') return true;
    return def.departments.some(d => d.toUpperCase() === userDept);
  });
}

function findAutoMappedCourse(subjectCode, semester, department) {
  if (!department) return null;
  const deptUpper = department.trim().toUpperCase();
  const semStr = String(semester || '').trim();
  const subjUpper = (subjectCode || '').trim().toUpperCase();

  const deptCourses = (state.courses || []).filter(c => (c.department || '').trim().toUpperCase() === deptUpper);
  const sameSemCourses = deptCourses.filter(c => String(c.semester || '').trim() === semStr);

  const scoreCourse = (c) => {
    const cat = (c.category || '').toUpperCase();
    const code = (c.code || '').toUpperCase();
    const name = (c.name || '').toUpperCase();

    if (subjUpper.startsWith('MDC')) {
      if (cat === 'MDC') return 100;
      if (code.includes('FM') || code.includes('MDC')) return 90;
      if (name.includes('MDC') || name.includes('MULTIDISCIPLINARY')) return 80;
    }
    if (subjUpper.startsWith('AEC')) {
      if (cat === 'AEC') return 100;
      if (code.includes('FA') || code.includes('AEC')) return 90;
      if (name.includes('AEC') || name.includes('ABILITY ENHANCEMENT')) return 80;
    }
    if (subjUpper.startsWith('VAC')) {
      if (cat === 'VAC') return 100;
      if (code.includes('FV') || code.includes('VAC')) return 90;
      if (name.includes('VAC') || name.includes('VALUE ADDITION')) return 80;
    }
    if (subjUpper.startsWith('SEC')) {
      if (cat === 'SEC') return 100;
      if (code.includes('FS') || code.includes('SEC')) return 90;
      if (name.includes('SEC') || name.includes('SKILL ENHANCEMENT')) return 80;
    }
    if (code.includes(subjUpper) || name.includes(subjUpper)) return 70;
    return 0;
  };

  let bestMatch = null;
  let bestScore = 0;
  sameSemCourses.forEach(c => {
    const s = scoreCourse(c);
    if (s > bestScore) {
      bestScore = s;
      bestMatch = c;
    }
  });

  if (bestMatch && bestScore > 0) return bestMatch;

  deptCourses.forEach(c => {
    const s = scoreCourse(c);
    if (s > bestScore) {
      bestScore = s;
      bestMatch = c;
    }
  });

  if (bestMatch && bestScore > 0) return bestMatch;
  return sameSemCourses[0] || deptCourses[0] || null;
}

function renderCommonSubjectMappingTiles() {
  const mainView = document.getElementById('common-subjects-main-view');
  const detailView = document.getElementById('common-subject-detail-view');
  const container = document.getElementById('common-subjects-tiles-grid');
  const deptBadge = document.getElementById('common-current-dept-badge');
  const semFilter = document.getElementById('common-sem-filter');
  if (!container) return;

  // If currently in detail view, re-render detail view instead
  if (selectedCommonSubjectCode) {
    openCommonSubjectDetail(selectedCommonSubjectCode);
    return;
  }

  if (mainView) mainView.classList.remove('hidden');
  if (detailView) detailView.classList.add('hidden');

  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').trim().toUpperCase();
  if (deptBadge) deptBadge.textContent = userDept || 'DEPARTMENT';

  let visibleSubjects = getVisibleCommonSubjects();
  const selectedSem = semFilter ? semFilter.value : '';
  if (selectedSem) {
    if (selectedSem === 'odd') {
      visibleSubjects = visibleSubjects.filter(subj => parseInt(String(subj.semester).replace(/\D+/g, ''), 10) % 2 === 1);
    } else if (selectedSem === 'even') {
      visibleSubjects = visibleSubjects.filter(subj => parseInt(String(subj.semester).replace(/\D+/g, ''), 10) % 2 === 0);
    } else {
      visibleSubjects = visibleSubjects.filter(subj => String(subj.semester) === String(selectedSem));
    }
  }

  const allBatches = state.commonBatches || [];

  if (visibleSubjects.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; background: #ffffff; border: 1.5px dashed var(--border); border-radius: var(--radius-md);">
        <i class="fa-solid fa-layer-group text-muted" style="font-size: 28px; margin-bottom: 8px;"></i>
        <h4 style="margin: 0 0 4px 0; font-size: 15px; font-weight: 700;">No Common Subjects Found</h4>
        <p class="text-muted text-xs mb-0">${selectedSem ? `No common subjects found for Semester ${selectedSem}.` : `No common subjects assigned to ${userDept}.`}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = visibleSubjects.map(subj => {
    const subjBatches = allBatches.filter(b => (b.subjectCode || '').toUpperCase() === subj.code.toUpperCase());
    const eligibleDeptStr = Array.isArray(subj.departments) ? subj.departments.join(', ') : 'All Departments';

    return `
      <div class="common-subject-card" onclick="openCommonSubjectDetail('${subj.code}')">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="subject-code-badge">${subj.code}</span>
            <span class="subject-sem-tag">Sem ${subj.semester}</span>
          </div>
          <h4 class="subject-card-title">${escapeHtml(subj.name)}</h4>
          <span class="text-xs text-muted" style="font-size: 11px; display: block;">${eligibleDeptStr}</span>
        </div>

        <div class="subject-card-meta">
          <span class="badge ${subjBatches.length > 0 ? 'badge-info' : ''}" style="${subjBatches.length === 0 ? 'background: #f1f5f9; color: #64748b;' : ''}">
            <i class="fa-solid fa-users"></i> ${subjBatches.length} Batch${subjBatches.length === 1 ? '' : 'es'}
          </span>
          <span class="action-indicator">
            Manage Batches <i class="fa-solid fa-arrow-right"></i>
          </span>
        </div>
      </div>
    `;
  }).join('');
}

window.openCommonSubjectDetail = function(subjectCode) {
  selectedCommonSubjectCode = subjectCode;
  const mainView = document.getElementById('common-subjects-main-view');
  const detailView = document.getElementById('common-subject-detail-view');
  if (mainView) mainView.classList.add('hidden');
  if (detailView) detailView.classList.remove('hidden');

  const subj = COMMON_SUBJECT_DEFINITIONS.find(s => s.code.toUpperCase() === subjectCode.toUpperCase()) || {
    code: subjectCode,
    name: subjectCode,
    semester: '1',
    departments: 'ALL'
  };

  const codeBadge = document.getElementById('detail-subject-code-badge');
  const titleEl = document.getElementById('detail-subject-title');
  const semTag = document.getElementById('detail-subject-sem-tag');
  const countPill = document.getElementById('detail-batches-count-pill');
  const container = document.getElementById('detail-subject-batches-container');

  if (codeBadge) codeBadge.textContent = subj.code;
  if (titleEl) titleEl.textContent = subj.name;
  if (semTag) semTag.textContent = `Semester ${subj.semester}`;

  const allBatches = state.commonBatches || [];
  const subjBatches = allBatches.filter(b => (b.subjectCode || '').toUpperCase() === subj.code.toUpperCase());
  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').trim().toUpperCase();

  if (countPill) {
    countPill.textContent = `${subjBatches.length} Batch${subjBatches.length === 1 ? '' : 'es'}`;
  }

  if (container) {
    if (subjBatches.length === 0) {
      container.innerHTML = `
        <div style="background: #ffffff; border: 1.5px dashed var(--border); border-radius: var(--radius-md); padding: 36px 20px; text-align: center;">
          <i class="fa-solid fa-folder-open text-muted" style="font-size: 32px; margin-bottom: 10px;"></i>
          <h4 style="margin: 0 0 4px 0; font-size: 15px; font-weight: 700;">No Batches Configured Yet</h4>
          <p class="text-muted text-xs mb-3">Create a batch to assign courses and faculty members for ${subj.code}.</p>
          <button type="button" class="btn btn-primary btn-sm" onclick="openCreateCommonBatchModal('${subj.code}', '${subj.semester}')">
            <i class="fa-solid fa-plus"></i> Create First Batch
          </button>
        </div>
      `;
    } else {
      container.innerHTML = subjBatches.map(b => {
        const batchDepts = Array.isArray(b.departments) && b.departments.length > 0 
          ? b.departments 
          : (b.department ? b.department.split(',').map(s => s.trim()) : []);
        const isOwnDept = batchDepts.some(d => d.toUpperCase() === userDept) || (b.department || '').toUpperCase() === userDept;
        return `
          <div class="common-batch-item-card ${isOwnDept ? 'is-own-dept' : ''}">
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
                <strong style="font-size: 14px; color: var(--text-main);">${escapeHtml(b.batchName)}</strong>
                ${batchDepts.map(d => `<span class="badge badge-info" style="font-size: 10px; padding: 2px 6px;">${escapeHtml(d)}</span>`).join(' ')}
                ${isOwnDept ? `<span class="badge badge-success" style="font-size: 10px; padding: 2px 6px;"><i class="fa-solid fa-check"></i> Your Dept</span>` : ''}
              </div>
              <div style="font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <span>Course: <strong style="color: var(--text-main);">${escapeHtml(b.courseCode || '')}${b.courseName ? ` &mdash; ${escapeHtml(b.courseName)}` : ''}</strong></span>
                <span>&bull;</span>
                <span>Faculty: <strong style="color: var(--primary);">${escapeHtml(b.teacherName || b.teacherCode || '')}</strong></span>
                ${b.department && batchDepts.length > 1 ? `<span>&bull;</span><span>Offering: <strong style="color: var(--text-main);">${escapeHtml(b.department)}</strong></span>` : ''}
              </div>
            </div>

            <div>
              ${isOwnDept ? `
                <div style="display: flex; gap: 6px; align-items: center;">
                  <button type="button" class="btn btn-outline btn-xs" style="color: var(--primary); border-color: #c7d2fe; padding: 4px 8px; border-radius: 4px;" title="Edit this batch / course mapping" onclick="editCommonBatch('${b.id}')">
                    <i class="fa-solid fa-pen-to-square"></i> Edit
                  </button>
                  <button type="button" class="btn btn-outline btn-xs" style="color: var(--danger); border-color: #fca5a5; padding: 4px 8px; border-radius: 4px;" title="Delete this batch" onclick="deleteCommonBatch('${b.id}')">
                    <i class="fa-solid fa-trash-can"></i> Delete
                  </button>
                </div>
              ` : `
                <span class="text-muted text-xs">External Dept</span>
              `}
            </div>
          </div>
        `;
      }).join('');
    }
  }
};

window.closeCommonSubjectDetail = function() {
  selectedCommonSubjectCode = null;
  const mainView = document.getElementById('common-subjects-main-view');
  const detailView = document.getElementById('common-subject-detail-view');
  if (detailView) detailView.classList.add('hidden');
  if (mainView) mainView.classList.remove('hidden');
  renderCommonSubjectMappingTiles();
};

window.editCommonBatch = function(batchId) {
  const batch = (state.commonBatches || []).find(b => b.id === batchId);
  if (!batch) return;
  openCreateCommonBatchModal(batch.subjectCode, batch.semester, batchId);
};

window.openCreateCommonBatchModal = function(subjectCode, semester, editingBatchId = null) {
  const modal = document.getElementById('modal-create-common-batch');
  if (!modal) return;

  const codeToUse = subjectCode || selectedCommonSubjectCode || 'MDC1';
  const subjDef = COMMON_SUBJECT_DEFINITIONS.find(s => s.code.toUpperCase() === codeToUse.toUpperCase()) || {
    code: codeToUse,
    name: codeToUse,
    semester: semester || '1',
    departments: 'ALL'
  };

  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').trim().toUpperCase();
  const existingBatch = editingBatchId ? (state.commonBatches || []).find(b => b.id === editingBatchId) : null;

  document.getElementById('common-batch-id').value = editingBatchId || '';
  document.getElementById('common-batch-subject-code').value = subjDef.code;
  document.getElementById('common-batch-semester').value = subjDef.semester;
  document.getElementById('common-batch-label-display').textContent = `${subjDef.code} \u2014 ${subjDef.name}`;
  document.getElementById('common-batch-sem-badge').textContent = `Semester ${subjDef.semester}`;

  const titleEl = document.getElementById('modal-common-batch-title');
  if (titleEl) {
    titleEl.textContent = existingBatch ? 'Edit Batch' : 'Create Batch';
  }

  const nameInput = document.getElementById('common-batch-name-input');
  if (existingBatch) {
    nameInput.value = existingBatch.batchName || '';
  } else {
    const subjBatches = (state.commonBatches || []).filter(b => (b.subjectCode || '').toUpperCase() === subjDef.code.toUpperCase());
    nameInput.value = `Batch ${subjBatches.length + 1}`;
  }

  const courseSelect = document.getElementById('common-batch-course-select');
  const selectedCourseCodeInput = document.getElementById('common-batch-selected-course-code');
  const courseConfirmEl = document.getElementById('common-batch-course-confirmation');
  const courseMetaEl = document.getElementById('common-batch-course-meta');
  const editMappingWrapper = document.getElementById('wrapper-edit-course-mapping');
  const btnToggleEditCourse = document.getElementById('btn-toggle-edit-course-mapping');

  if (editMappingWrapper) {
    editMappingWrapper.classList.add('hidden');
  }

  // Auto-fetch offering department from logged-in department (or existing batch's offering dept)
  const offeringDept = (existingBatch && existingBatch.department) ? existingBatch.department.toUpperCase() : (userDept || 'ENGLISH');
  const offeringDeptDisplay = document.getElementById('common-batch-offering-dept-display');
  const offeringDeptVal = document.getElementById('common-batch-offering-dept-val');
  if (offeringDeptDisplay) offeringDeptDisplay.textContent = offeringDept;
  if (offeringDeptVal) offeringDeptVal.value = offeringDept;

  // Always include all departments across the institution for participating departments selection
  let allDepts = [];
  if (Array.isArray(state.departments) && state.departments.length > 0) {
    allDepts = state.departments.map(d => typeof d === 'string' ? d : d.name).filter(Boolean);
  }
  if (allDepts.length === 0) {
    allDepts = ['BOTANY', 'CHEMISTRY', 'COMMERCE', 'COMPUTER SCIENCE', 'ECONOMICS', 'ELECTRONICS', 'ENGLISH', 'HINDI', 'HISTORY', 'MALAYALAM', 'MATHEMATICS', 'PHYSICS', 'POLITICAL SCIENCE', 'PSYCHOLOGY', 'SANSKRIT', 'STATISTICS', 'ZOOLOGY'];
  }
  const eligibleDepts = Array.from(new Set(allDepts.map(d => d.trim().toUpperCase()))).sort();

  // Determine initial selected participating departments
  let initialSelectedDepts = [];
  if (existingBatch) {
    initialSelectedDepts = Array.isArray(existingBatch.departments) && existingBatch.departments.length > 0 
      ? existingBatch.departments 
      : (existingBatch.department ? [existingBatch.department] : [offeringDept]);
  } else {
    initialSelectedDepts = offeringDept && eligibleDepts.includes(offeringDept) ? [offeringDept] : [eligibleDepts[0]];
  }

  // Department Searchable Multi-Select Dropdown Controls
  const deptsBtn = document.getElementById('common-batch-depts-dropdown-btn');
  const deptsMenu = document.getElementById('common-batch-depts-dropdown-menu');
  const deptsChevron = document.getElementById('common-batch-depts-chevron');
  const deptsTriggerText = document.getElementById('common-batch-depts-trigger-text');
  const deptsSearchInput = document.getElementById('common-batch-depts-search-input');
  const deptsList = document.getElementById('common-batch-depts-list');
  const deptsCountBadge = document.getElementById('common-batch-depts-count-badge');
  const deptsModalCount = document.getElementById('common-batch-depts-modal-count');
  const btnDeptsSelectAll = document.getElementById('btn-batch-depts-select-all');
  const btnDeptsClearAll = document.getElementById('btn-batch-depts-clear-all');
  const btnDeptsDone = document.getElementById('btn-batch-depts-done');

  if (deptsMenu) deptsMenu.classList.add('hidden');
  if (deptsChevron) deptsChevron.style.transform = 'rotate(0deg)';
  if (deptsSearchInput) deptsSearchInput.value = '';

  if (deptsList) {
    deptsList.innerHTML = eligibleDepts.map(d => {
      const isChecked = initialSelectedDepts.some(x => x.toUpperCase() === d.toUpperCase());
      return `
        <label class="dropdown-check-item dropdown-dept-item" data-name="${escapeHtml(d)}">
          <input type="checkbox" class="common-batch-dept-cb" value="${escapeHtml(d)}" ${isChecked ? 'checked' : ''}>
          <span>${escapeHtml(d)}</span>
        </label>
      `;
    }).join('');
  }

  const updateSelectedDeptsUI = () => {
    const checkedCbs = deptsList ? Array.from(deptsList.querySelectorAll('.common-batch-dept-cb:checked')) : [];
    const checkedDepts = checkedCbs.map(cb => cb.value);

    if (deptsCountBadge) deptsCountBadge.textContent = `${checkedDepts.length} Selected`;
    if (deptsModalCount) deptsModalCount.textContent = `${checkedDepts.length} of ${eligibleDepts.length} selected`;

    if (deptsTriggerText) {
      if (checkedDepts.length === 0) {
        deptsTriggerText.innerHTML = '<span class="text-muted">Select participating departments...</span>';
      } else if (checkedDepts.length === 1) {
        deptsTriggerText.innerHTML = `<span style="font-weight: 600; color: var(--text-main);">${escapeHtml(checkedDepts[0])}</span>`;
      } else if (checkedDepts.length <= 3) {
        deptsTriggerText.innerHTML = `<span style="font-weight: 600; color: var(--text-main);">${checkedDepts.map(d => escapeHtml(d)).join(', ')}</span>`;
      } else {
        deptsTriggerText.innerHTML = `
          <span class="badge badge-info" style="font-size: 10px; padding: 2px 6px; font-weight: 700;">${checkedDepts.length} Departments Selected</span>
          <span style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">(${escapeHtml(checkedDepts.slice(0, 2).join(', '))}, +${checkedDepts.length - 2} more)</span>
        `;
      }
    }
  };

  if (deptsSearchInput && deptsList) {
    deptsSearchInput.oninput = () => {
      const q = deptsSearchInput.value.trim().toUpperCase();
      deptsList.querySelectorAll('.dropdown-dept-item').forEach(lbl => {
        const name = (lbl.getAttribute('data-name') || '').toUpperCase();
        lbl.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
      });
    };
  }

  if (deptsList) {
    deptsList.onchange = updateSelectedDeptsUI;
  }
  if (btnDeptsSelectAll && deptsList) {
    btnDeptsSelectAll.onclick = () => {
      deptsList.querySelectorAll('.dropdown-dept-item').forEach(lbl => {
        if (lbl.style.display !== 'none') {
          const cb = lbl.querySelector('input');
          if (cb) cb.checked = true;
        }
      });
      updateSelectedDeptsUI();
    };
  }
  if (btnDeptsClearAll && deptsList) {
    btnDeptsClearAll.onclick = () => {
      deptsList.querySelectorAll('.common-batch-dept-cb').forEach(cb => { cb.checked = false; });
      updateSelectedDeptsUI();
    };
  }
  if (deptsBtn && deptsMenu) {
    deptsBtn.onclick = (e) => {
      e.stopPropagation();
      const isClosed = deptsMenu.classList.contains('hidden');
      const teachersMenuEl = document.getElementById('common-batch-teachers-dropdown-menu');
      const teachersChevronEl = document.getElementById('common-batch-teachers-chevron');
      if (teachersMenuEl) {
        teachersMenuEl.classList.add('hidden');
        if (teachersChevronEl) teachersChevronEl.style.transform = 'rotate(0deg)';
      }
      if (isClosed) {
        deptsMenu.classList.remove('hidden');
        if (deptsChevron) deptsChevron.style.transform = 'rotate(180deg)';
        if (deptsSearchInput) {
          deptsSearchInput.value = '';
          deptsSearchInput.focus();
          deptsList.querySelectorAll('.dropdown-dept-item').forEach(lbl => { lbl.style.display = 'flex'; });
        }
      } else {
        deptsMenu.classList.add('hidden');
        if (deptsChevron) deptsChevron.style.transform = 'rotate(0deg)';
      }
    };
  }
  if (btnDeptsDone && deptsMenu) {
    btnDeptsDone.onclick = (e) => {
      e.stopPropagation();
      deptsMenu.classList.add('hidden');
      if (deptsChevron) deptsChevron.style.transform = 'rotate(0deg)';
    };
  }
  updateSelectedDeptsUI();

  const updateCourseConfirmationDisplay = (course) => {
    if (!course) {
      if (courseConfirmEl) courseConfirmEl.innerHTML = `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation"></i> No matching course found</span>`;
      if (courseMetaEl) courseMetaEl.textContent = 'Please click "Change Course" to select a course manually.';
      if (selectedCourseCodeInput) selectedCourseCodeInput.value = '';
      if (editMappingWrapper) editMappingWrapper.classList.remove('hidden');
      return;
    }

    if (selectedCourseCodeInput) selectedCourseCodeInput.value = course.code;
    if (courseConfirmEl) {
      courseConfirmEl.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="badge badge-info" style="font-size: 11px; padding: 3px 8px; font-weight: 700;">${escapeHtml(course.code)}</span>
          <span style="font-size: 13px; font-weight: 600; color: var(--text-main);">${escapeHtml(course.name || course.code)}</span>
        </div>
      `;
    }
    if (courseMetaEl) {
      courseMetaEl.innerHTML = `Semester ${course.semester || subjDef.semester} &bull; Category: <strong>${escapeHtml(course.category || 'MDC')}</strong> &bull; <span class="text-success"><i class="fa-solid fa-circle-check"></i> Ready for batch</span>`;
    }
  };

  // Populate Courses offered by this offering department
  const deptCourses = state.courses.filter(c => (c.department || '').trim().toUpperCase() === offeringDept);
  deptCourses.sort((a, b) => {
    const aMatch = String(a.semester) === String(subjDef.semester) ? 0 : 1;
    const bMatch = String(b.semester) === String(subjDef.semester) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return (a.code || '').localeCompare(b.code || '');
  });

  if (deptCourses.length === 0) {
    courseSelect.innerHTML = `<option value="">No courses found for ${offeringDept}</option>`;
  } else {
    courseSelect.innerHTML = deptCourses.map(c => `
      <option value="${c.code}" data-title="${escapeHtml(c.name || '')}" data-category="${escapeHtml(c.category || '')}" data-sem="${c.semester || ''}">
        ${c.code} - ${escapeHtml(c.name || '')} (Sem ${c.semester || '?'}, ${c.category || 'Course'})
      </option>
    `).join('');
  }

  // Determine initial mapped course
  let targetCourse = null;
  if (existingBatch && existingBatch.courseCode) {
    targetCourse = deptCourses.find(c => c.code === existingBatch.courseCode);
  }
  if (!targetCourse) {
    targetCourse = findAutoMappedCourse(subjDef.code, subjDef.semester, offeringDept);
  }

  if (targetCourse) {
    courseSelect.value = targetCourse.code;
    updateCourseConfirmationDisplay(targetCourse);
  } else {
    updateCourseConfirmationDisplay(deptCourses[0] || null);
  }

  // Populate Teachers (Multi-select) from the offering department
  const deptFaculty = state.faculty.filter(f => (f.department || '').trim().toUpperCase() === offeringDept);
  deptFaculty.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  let initialSelectedTeachers = [];
  if (existingBatch) {
    if (Array.isArray(existingBatch.teachers) && existingBatch.teachers.length > 0) {
      initialSelectedTeachers = existingBatch.teachers;
    } else if (existingBatch.teacherCode) {
      initialSelectedTeachers = existingBatch.teacherCode.split(',').map(s => s.trim());
    }
  }

  // Teacher Searchable Multi-Select Dropdown Controls
  const teachersBtn = document.getElementById('common-batch-teachers-dropdown-btn');
  const teachersMenu = document.getElementById('common-batch-teachers-dropdown-menu');
  const teachersChevron = document.getElementById('common-batch-teachers-chevron');
  const teachersTriggerText = document.getElementById('common-batch-teachers-trigger-text');
  const teachersSearchInput = document.getElementById('common-batch-teachers-search-input');
  const teachersList = document.getElementById('common-batch-teachers-list');
  const teachersCountBadge = document.getElementById('common-batch-teachers-count-badge');
  const teachersModalCount = document.getElementById('common-batch-teachers-modal-count');
  const btnTeachersSelectAll = document.getElementById('btn-batch-teachers-select-all');
  const btnTeachersClearAll = document.getElementById('btn-batch-teachers-clear-all');
  const btnTeachersDone = document.getElementById('btn-batch-teachers-done');

  if (teachersMenu) teachersMenu.classList.add('hidden');
  if (teachersChevron) teachersChevron.style.transform = 'rotate(0deg)';
  if (teachersSearchInput) teachersSearchInput.value = '';

  if (teachersList) {
    if (deptFaculty.length === 0) {
      teachersList.innerHTML = `<span class="text-muted text-xs p-2">No faculty found in ${escapeHtml(offeringDept)}</span>`;
    } else {
      teachersList.innerHTML = deptFaculty.map(f => {
        const isChecked = initialSelectedTeachers.includes(f.code);
        return `
          <label class="dropdown-check-item dropdown-teacher-item" data-name="${escapeHtml(f.name || f.code)}" data-code="${escapeHtml(f.code)}">
            <input type="checkbox" class="common-batch-teacher-cb" value="${escapeHtml(f.code)}" data-name="${escapeHtml(f.name || f.code)}" ${isChecked ? 'checked' : ''}>
            <strong style="color: var(--primary); min-width: 32px; font-size: 11px;">${escapeHtml(f.code)}</strong>
            <span>${escapeHtml(f.name || f.code)}</span>
          </label>
        `;
      }).join('');
    }
  }

  const updateSelectedTeachersUI = () => {
    const checkedCbs = teachersList ? Array.from(teachersList.querySelectorAll('.common-batch-teacher-cb:checked')) : [];
    const checkedNames = checkedCbs.map(cb => cb.getAttribute('data-name') || cb.value);

    if (teachersCountBadge) teachersCountBadge.textContent = `${checkedCbs.length} Selected`;
    if (teachersModalCount) teachersModalCount.textContent = `${checkedCbs.length} of ${deptFaculty.length} selected`;

    if (teachersTriggerText) {
      if (checkedCbs.length === 0) {
        teachersTriggerText.innerHTML = '<span class="text-muted">Select faculty members...</span>';
      } else if (checkedCbs.length === 1) {
        teachersTriggerText.innerHTML = `<span style="font-weight: 600; color: var(--text-main);">${escapeHtml(checkedNames[0])}</span>`;
      } else if (checkedCbs.length <= 2) {
        teachersTriggerText.innerHTML = `<span style="font-weight: 600; color: var(--text-main);">${checkedNames.map(n => escapeHtml(n)).join(', ')}</span>`;
      } else {
        teachersTriggerText.innerHTML = `
          <span class="badge badge-info" style="font-size: 10px; padding: 2px 6px; font-weight: 700;">${checkedCbs.length} Faculty Selected</span>
          <span style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">(${escapeHtml(checkedNames.slice(0, 2).join(', '))}, +${checkedCbs.length - 2} more)</span>
        `;
      }
    }
  };

  if (teachersSearchInput && teachersList) {
    teachersSearchInput.oninput = () => {
      const q = teachersSearchInput.value.trim().toUpperCase();
      teachersList.querySelectorAll('.dropdown-teacher-item').forEach(lbl => {
        const name = (lbl.getAttribute('data-name') || '').toUpperCase();
        const code = (lbl.getAttribute('data-code') || '').toUpperCase();
        lbl.style.display = (!q || name.includes(q) || code.includes(q)) ? 'flex' : 'none';
      });
    };
  }

  if (teachersList) {
    teachersList.onchange = updateSelectedTeachersUI;
  }
  if (btnTeachersSelectAll && teachersList) {
    btnTeachersSelectAll.onclick = () => {
      teachersList.querySelectorAll('.dropdown-teacher-item').forEach(lbl => {
        if (lbl.style.display !== 'none') {
          const cb = lbl.querySelector('input');
          if (cb) cb.checked = true;
        }
      });
      updateSelectedTeachersUI();
    };
  }
  if (btnTeachersClearAll && teachersList) {
    btnTeachersClearAll.onclick = () => {
      teachersList.querySelectorAll('.common-batch-teacher-cb').forEach(cb => { cb.checked = false; });
      updateSelectedTeachersUI();
    };
  }
  if (teachersBtn && teachersMenu) {
    teachersBtn.onclick = (e) => {
      e.stopPropagation();
      const isClosed = teachersMenu.classList.contains('hidden');
      const deptsMenuEl = document.getElementById('common-batch-depts-dropdown-menu');
      const deptsChevronEl = document.getElementById('common-batch-depts-chevron');
      if (deptsMenuEl) {
        deptsMenuEl.classList.add('hidden');
        if (deptsChevronEl) deptsChevronEl.style.transform = 'rotate(0deg)';
      }
      if (isClosed) {
        teachersMenu.classList.remove('hidden');
        if (teachersChevron) teachersChevron.style.transform = 'rotate(180deg)';
        if (teachersSearchInput) {
          teachersSearchInput.value = '';
          teachersSearchInput.focus();
          teachersList.querySelectorAll('.dropdown-teacher-item').forEach(lbl => { lbl.style.display = 'flex'; });
        }
      } else {
        teachersMenu.classList.add('hidden');
        if (teachersChevron) teachersChevron.style.transform = 'rotate(0deg)';
      }
    };
  }
  if (btnTeachersDone && teachersMenu) {
    btnTeachersDone.onclick = (e) => {
      e.stopPropagation();
      teachersMenu.classList.add('hidden');
      if (teachersChevron) teachersChevron.style.transform = 'rotate(0deg)';
    };
  }
  updateSelectedTeachersUI();

  // Close dropdowns when clicking outside
  modal.onclick = (e) => {
    if (deptsMenu && !deptsMenu.contains(e.target) && deptsBtn && !deptsBtn.contains(e.target)) {
      deptsMenu.classList.add('hidden');
      if (deptsChevron) deptsChevron.style.transform = 'rotate(0deg)';
    }
    if (teachersMenu && !teachersMenu.contains(e.target) && teachersBtn && !teachersBtn.contains(e.target)) {
      teachersMenu.classList.add('hidden');
      if (teachersChevron) teachersChevron.style.transform = 'rotate(0deg)';
    }
  };

  if (btnToggleEditCourse) {
    btnToggleEditCourse.onclick = (e) => {
      e.preventDefault();
      if (editMappingWrapper) {
        editMappingWrapper.classList.toggle('hidden');
      }
    };
  }

  courseSelect.onchange = () => {
    const chosenCode = courseSelect.value;
    const courseObj = state.courses.find(c => c.code === chosenCode);
    updateCourseConfirmationDisplay(courseObj);
  };

  modal.classList.remove('hidden');
};

window.deleteCommonBatch = async function(batchId) {
  showModalConfirm('Delete Batch', 'Are you sure you want to delete this batch?', async () => {
    try {
      const res = await authFetch(`${API_BASE}/common-batches/${batchId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (res.ok) {
        state.commonBatches = data.batches || state.commonBatches.filter(b => b.id !== batchId);
        if (selectedCommonSubjectCode) {
          openCommonSubjectDetail(selectedCommonSubjectCode);
        } else {
          renderCommonSubjectMappingTiles();
        }
      } else {
        showModalAlert('Error', data.message || 'Failed to delete batch', 'danger');
      }
    } catch (e) {
      console.error(e);
      showModalAlert('Error', 'Connection error while deleting batch', 'danger');
    }
  });
};

function bindCommonSubjectMappingEvents() {
  const semFilter = document.getElementById('common-sem-filter');
  const btnBack = document.getElementById('btn-back-to-common-subjects');
  const btnOpenCreate = document.getElementById('btn-open-create-batch');
  const btnSubmitBatch = document.getElementById('btn-submit-common-batch');
  const btnCloseBatchModal = document.getElementById('btn-close-common-batch-modal');
  const btnCancelBatchModal = document.getElementById('btn-cancel-common-batch');
  const modalBatch = document.getElementById('modal-create-common-batch');

  if (semFilter) {
    semFilter.addEventListener('change', () => {
      renderCommonSubjectMappingTiles();
    });
  }

  if (btnBack) {
    btnBack.addEventListener('click', closeCommonSubjectDetail);
  }

  if (btnOpenCreate) {
    btnOpenCreate.addEventListener('click', () => {
      if (selectedCommonSubjectCode) {
        const subj = COMMON_SUBJECT_DEFINITIONS.find(s => s.code.toUpperCase() === selectedCommonSubjectCode.toUpperCase());
        openCreateCommonBatchModal(selectedCommonSubjectCode, subj ? subj.semester : '1');
      }
    });
  }

  const closeBatchModal = () => {
    if (modalBatch) modalBatch.classList.add('hidden');
  };

  if (btnCloseBatchModal) btnCloseBatchModal.onclick = closeBatchModal;
  if (btnCancelBatchModal) btnCancelBatchModal.onclick = closeBatchModal;

  if (btnSubmitBatch) {
    btnSubmitBatch.onclick = async () => {
      const batchId = document.getElementById('common-batch-id').value;
      const subjectCode = document.getElementById('common-batch-subject-code').value;
      const semester = document.getElementById('common-batch-semester').value;
      const offeringDept = (document.getElementById('common-batch-offering-dept-val')?.value || (state.currentUser && state.currentUser.departmentName) || 'ENGLISH').trim().toUpperCase();
      const courseSelect = document.getElementById('common-batch-course-select');
      const selectedCourseCodeInput = document.getElementById('common-batch-selected-course-code');
      const nameInput = document.getElementById('common-batch-name-input');

      const batchName = nameInput.value.trim();
      if (!batchName) {
        showModalAlert('Required Field', 'Please enter a name for the batch.', 'warning');
        nameInput.focus();
        return;
      }

      const courseCode = (selectedCourseCodeInput && selectedCourseCodeInput.value) || courseSelect.value;
      if (!courseCode) {
        showModalAlert('Required Field', 'Please select or map a course that the department offers.', 'warning');
        return;
      }

      const teachersList = document.getElementById('common-batch-teachers-list');
      const checkedTeacherCbs = teachersList ? Array.from(teachersList.querySelectorAll('.common-batch-teacher-cb:checked')) : [];
      if (checkedTeacherCbs.length === 0) {
        showModalAlert('Required Field', 'Please select at least one assigned faculty member.', 'warning');
        return;
      }

      const selectedTeacherCodes = checkedTeacherCbs.map(cb => cb.value);
      const selectedTeacherNames = checkedTeacherCbs.map(cb => cb.getAttribute('data-name') || cb.value);

      const courseObj = state.courses.find(c => c.code === courseCode);
      const courseName = courseObj ? courseObj.name : (courseSelect.options[courseSelect.selectedIndex]?.getAttribute('data-title') || '');

      const deptsList = document.getElementById('common-batch-depts-list');
      const checkedDepts = deptsList ? Array.from(deptsList.querySelectorAll('.common-batch-dept-cb:checked')).map(cb => cb.value) : [];

      if (checkedDepts.length === 0) {
        showModalAlert('Required Field', 'Please select at least one participating department.', 'warning');
        return;
      }

      const batchData = {
        subjectCode,
        semester,
        department: offeringDept,
        departments: checkedDepts,
        courseCode,
        courseName,
        teacherCode: selectedTeacherCodes.join(', '),
        teacherName: selectedTeacherNames.join(', '),
        teachers: selectedTeacherCodes,
        batchName
      };

      if (batchId) {
        batchData.id = batchId;
      }

      try {
        const res = await authFetch(`${API_BASE}/common-batches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: batchData })
        });
        const data = await res.json();
        if (res.ok) {
          state.commonBatches = data.batches || [];
          closeBatchModal();
          if (selectedCommonSubjectCode) {
            openCommonSubjectDetail(selectedCommonSubjectCode);
          } else {
            renderCommonSubjectMappingTiles();
          }
          showModalAlert('Success', `Batch "${batchName}" successfully ${batchId ? 'updated' : 'created'}.`, 'success');
        } else {
          showModalAlert('Error', data.message || 'Failed to save batch', 'danger');
        }
      } catch (err) {
        console.error(err);
        showModalAlert('Error', 'Failed to save batch due to connection error.', 'danger');
      }
    };
  }
}

function openLockedPeriodDetailsModal(day, period, courseSem, globalLock, openSelector) {
  const modal = document.getElementById('modal-locked-period-details');
  if (!modal) {
    if (confirm(`This period (${day} Period ${period}) is locked institution-wide: "${globalLock.label || 'College Common Activity'}". Do you want to manually assign faculty?`)) {
      openSelector();
    }
    return;
  }

  const slotInfo = document.getElementById('locked-period-slot-info');
  const semBadge = document.getElementById('locked-period-sem-badge');
  const labelBadge = document.getElementById('locked-period-label-badge');
  const countBadge = document.getElementById('locked-period-batches-count');
  const container = document.getElementById('locked-period-batches-container');
  const btnMapping = document.getElementById('btn-locked-period-open-mapping');
  const btnManual = document.getElementById('btn-locked-period-manual-assign');
  const btnClose = document.getElementById('btn-locked-period-close');
  const btnCloseX = document.getElementById('btn-close-locked-period-modal');

  const lockLabel = (globalLock.label || 'College Activity').trim();
  const lockSem = globalLock.semester && globalLock.semester !== 'all' ? globalLock.semester : (courseSem || 'All');

  if (slotInfo) slotInfo.innerHTML = `<strong>${day}</strong> &bull; Period ${period}`;
  if (semBadge) semBadge.textContent = lockSem === 'All' ? 'All Semesters' : `Semester ${lockSem}`;
  if (labelBadge) labelBadge.textContent = lockLabel;

  // Filter matching common batches
  const batches = state.commonBatches || [];
  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
  
  // Find batches that match the label or subject code
  const lUpper = lockLabel.toUpperCase();
  const lClean = lUpper.replace(/[^A-Z0-9]/g, '');
  const matchingBatches = batches.filter(b => {
    const bCode = (b.subjectCode || '').toUpperCase();
    const bClean = bCode.replace(/[^A-Z0-9]/g, '');
    const codeMatches = (bCode === lUpper) || (bClean && bClean === lClean) || (b.subjectCode && lUpper.includes(bCode)) || (lUpper && bCode.includes(lUpper));
    const semMatches = !lockSem || lockSem === 'All' || lockSem === 'all' || !b.semester || String(b.semester) === String(lockSem);
    return codeMatches && semMatches;
  });

  if (countBadge) {
    countBadge.textContent = `${matchingBatches.length} Batch${matchingBatches.length === 1 ? '' : 'es'}`;
  }

  if (container) {
    if (matchingBatches.length === 0) {
      container.innerHTML = `
        <div style="padding: 20px; background: #ffffff; border: 1.5px dashed var(--border); border-radius: 8px; text-align: center;">
          <p class="text-muted text-xs mb-1" style="font-weight: 600;"><i class="fa-solid fa-circle-info text-primary"></i> No batches configured yet for "${escapeHtml(lockLabel)}".</p>
          <span class="text-muted" style="font-size: 11px;">You can configure batches under <strong>Common Subject Mapping</strong>.</span>
        </div>
      `;
    } else {
      container.innerHTML = matchingBatches.map(b => {
        const isOffering = (b.department || '').toUpperCase() === userDept;
        const bDepts = Array.isArray(b.departments) && b.departments.length > 0
          ? b.departments.map(d => String(d).trim())
          : [(b.department || '').trim()];
        const isParticipating = bDepts.some(d => d.toUpperCase() === userDept);

        return `
          <div style="background: ${(isOffering || isParticipating) ? '#f8faff' : '#ffffff'}; border: 1.5px solid ${(isOffering || isParticipating) ? '#bfdbfe' : 'var(--border)'}; border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
                <strong style="font-size: 13px; color: var(--text-main);">${escapeHtml(b.batchName || 'Batch')}</strong>
                <span class="badge badge-info" style="font-size: 9px; padding: 1px 5px;" title="Offering Department">Offered by: ${escapeHtml(b.department || 'TBD')}</span>
                ${isOffering ? `<span class="badge badge-success" style="font-size: 9px; padding: 1px 5px;"><i class="fa-solid fa-check"></i> Your Dept (Offering)</span>` : ''}
                ${(!isOffering && isParticipating) ? `<span class="badge badge-primary" style="font-size: 9px; padding: 1px 5px;"><i class="fa-solid fa-users"></i> Your Dept (Participating)</span>` : ''}
              </div>
              <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 3px;">
                <span>Course: <strong style="color: var(--text-main);">${escapeHtml(b.courseCode || '')}${b.courseName ? ` - ${escapeHtml(b.courseName)}` : ''}</strong></span>
              </div>
              <div style="font-size: 10.5px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <span>Participating:</span>
                ${bDepts.map(d => `<span style="background: #e2e8f0; color: #334155; padding: 0 4px; border-radius: 3px; font-size: 9.5px; font-weight: 600;">${escapeHtml(d)}</span>`).join('')}
              </div>
            </div>
            <div style="text-align: right; flex-shrink: 0;">
              <span class="fac-pill" style="margin: 0; font-weight: 600; font-size: 11px;" title="Teacher(s): ${escapeHtml(b.teacherName || '')} (${escapeHtml(b.teacherCode || '')})">
                <i class="fa-solid fa-chalkboard-user"></i> ${escapeHtml(b.teacherName || b.teacherCode || 'TBD')}
              </span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  const closeModal = () => {
    modal.classList.add('hidden');
  };

  if (btnClose) btnClose.onclick = closeModal;
  if (btnCloseX) btnCloseX.onclick = closeModal;

  if (btnMapping) {
    btnMapping.onclick = () => {
      closeModal();
      openAdvancedFeaturesModal('adv-pane-common-subject-mapping');
      if (matchingBatches.length > 0 && matchingBatches[0].subjectCode) {
        openCommonSubjectDetail(matchingBatches[0].subjectCode);
      }
    };
  }

  if (btnManual) {
    btnManual.onclick = () => {
      closeModal();
      openSelector();
    };
  }

  modal.classList.remove('hidden');
}

// -------------------------------------------------------------
// TAB 3: Auto Timetable Generator Pane Controller
// -------------------------------------------------------------
function populateAutoGenSemFilter() {
  const semSelect = document.getElementById('auto-gen-sem-select');
  const progSelect = document.getElementById('auto-gen-program-select');
  if (!semSelect) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const selectedProg = progSelect ? progSelect.value : '';

  const curVal = semSelect.value;
  semSelect.innerHTML = `
    <option value="">All Semesters in Department</option>
    <option value="odd">Odd Semesters (1, 3, 5)</option>
    <option value="even">Even Semesters (2, 4)</option>
  `;

  if (selectedProg === 'UG') {
    const sems = Array.from(new Set(deptCourses.filter(c => (c.programType || 'UG') === 'UG').map(c => c.semester))).sort((a,b) => parseInt(a||0) - parseInt(b||0));
    sems.forEach(s => {
      semSelect.innerHTML += `<option value="${s}">Semester ${s} (BSc)</option>`;
    });
  } else if (selectedProg === 'PG') {
    const sems = Array.from(new Set(deptCourses.filter(c => (c.programType || 'UG') === 'PG').map(c => c.semester))).sort((a,b) => parseInt(a||0) - parseInt(b||0));
    sems.forEach(s => {
      semSelect.innerHTML += `<option value="${s}">Semester ${s} (MSc)</option>`;
    });
  } else {
    // All Programs: clearly distinguish BSc and MSc
    const pairs = [];
    deptCourses.forEach(c => {
      const prog = c.programType || 'UG';
      const key = `${c.semester}_${prog}`;
      if (!pairs.some(p => p.key === key)) {
        pairs.push({ key, sem: c.semester, prog });
      }
    });
    pairs.sort((a, b) => {
      const semDiff = parseInt(a.sem || 0) - parseInt(b.sem || 0);
      if (semDiff !== 0) return semDiff;
      return a.prog.localeCompare(b.prog);
    });

    pairs.forEach(p => {
      const progLabel = p.prog === 'PG' ? 'MSc' : 'BSc';
      semSelect.innerHTML += `<option value="${p.key}">Semester ${p.sem} (${progLabel})</option>`;
    });
  }

  if (Array.from(semSelect.options).some(o => o.value === curVal)) {
    semSelect.value = curVal;
  }
}

function initAutoGeneratorPane() {
  const resultsCard = document.getElementById('auto-gen-results-card');
  const btnApply = document.getElementById('btn-apply-auto-generate');
  const errBox = document.getElementById('auto-gen-error-alert');
  const insectionSolver = document.getElementById('auto-gen-insection-solver');

  if (resultsCard) resultsCard.classList.add('hidden');
  if (btnApply) btnApply.classList.add('hidden');
  if (errBox) errBox.classList.add('hidden');
  if (insectionSolver) insectionSolver.classList.add('hidden');
  tempGeneratedAllocations = null;

  // Populate semester dropdown
  populateAutoGenSemFilter();

  // Update global locks status badge
  const locksBadge = document.getElementById('auto-gen-global-locks-badge');
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  if (locksBadge) {
    locksBadge.textContent = `${globalLocks.length} Locked`;
  }

  renderAutoGeneratorBindings();
}

let lastAutoGenFilterKey = null;

function renderAutoGeneratorBindings() {
  const container = document.getElementById('auto-gen-faculty-bindings-list');
  const countSpan = document.getElementById('auto-gen-courses-count');
  const semSelect = document.getElementById('auto-gen-sem-select');
  const progSelect = document.getElementById('auto-gen-program-select');
  const selectAllCb = document.getElementById('auto-gen-select-all-courses');
  const sortSelect = document.getElementById('auto-gen-courses-sort');
  const searchInput = document.getElementById('auto-gen-courses-search');
  if (!container) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  let deptCourses = state.courses.filter(c => c.department === deptName);

  // Filter by Program (BSc / MSc)
  const targetProg = progSelect ? progSelect.value : '';
  if (targetProg) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === targetProg);
  }

  // Filter by Semester (supports simple sem '1', odd, even, or combined '1_UG' / '1_PG')
  const targetSem = semSelect ? semSelect.value : '';
  if (targetSem) {
    if (targetSem === 'odd') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 1);
    } else if (targetSem === 'even') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 0);
    } else if (targetSem.includes('_')) {
      const [sNum, sProg] = targetSem.split('_');
      deptCourses = deptCourses.filter(c => String(c.semester) === String(sNum) && (c.programType || 'UG') === sProg);
    } else {
      deptCourses = deptCourses.filter(c => String(c.semester) === String(targetSem));
    }
  }

  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  if (query) {
    deptCourses = deptCourses.filter(c => 
      c.code.toLowerCase().includes(query) || 
      c.name.toLowerCase().includes(query) ||
      (c.alias && c.alias.toLowerCase().includes(query))
    );
  }

  const sortMode = sortSelect ? sortSelect.value : 'code-asc';
  deptCourses.sort((a, b) => {
    const mapA = localSubjectMappings[a.code] || a;
    const mapB = localSubjectMappings[b.code] || b;
    if (sortMode === 'code-asc') return a.code.localeCompare(b.code);
    if (sortMode === 'code-desc') return b.code.localeCompare(a.code);
    if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
    if (sortMode === 'sem-asc') return parseInt(a.semester || 0) - parseInt(b.semester || 0);
    if (sortMode === 'hours-desc') return (parseInt(mapB.hours) || 0) - (parseInt(mapA.hours) || 0);
    if (sortMode === 'type') {
      const typeA = (mapA.courseType === 'P' || a.code.endsWith('-P')) ? 'P' : 'T';
      const typeB = (mapB.courseType === 'P' || b.code.endsWith('-P')) ? 'P' : 'T';
      return typeA.localeCompare(typeB);
    }
    return 0;
  });

  const filterKey = `${targetProg}|${targetSem}|${query}`;
  const filterChanged = (lastAutoGenFilterKey !== null && filterKey !== lastAutoGenFilterKey);
  lastAutoGenFilterKey = filterKey;

  // Preserve or select all for currently filtered view
  const currentChecked = new Set();
  const existingCbs = container.querySelectorAll('.auto-gen-course-cb');
  if (existingCbs.length > 0 && !filterChanged) {
    existingCbs.forEach(cb => {
      if (cb.checked) currentChecked.add(cb.value);
    });
  } else {
    // When filter changes, default to selecting all courses in this filtered section
    deptCourses.forEach(c => currentChecked.add(c.code));
  }

  function updateSelectedCount() {
    const allCbs = container.querySelectorAll('.auto-gen-course-cb');
    const checkedCbs = container.querySelectorAll('.auto-gen-course-cb:checked');
    if (countSpan) countSpan.textContent = `${checkedCbs.length} of ${allCbs.length}`;
    if (selectAllCb) {
      selectAllCb.checked = allCbs.length > 0 && checkedCbs.length === allCbs.length;
      selectAllCb.indeterminate = checkedCbs.length > 0 && checkedCbs.length < allCbs.length;
    }
  }

  if (deptCourses.length === 0) {
    container.innerHTML = `<div class="text-muted text-sm text-center py-3"><i class="fa-solid fa-magnifying-glass mb-1"></i><br>No courses found matching filter.</div>`;
    if (countSpan) countSpan.textContent = '0';
    if (selectAllCb) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
    return;
  }

  const deptFaculty = state.faculty.filter(f => f.department === deptName);

  let html = '';
  deptCourses.forEach(c => {
    const mapObj = localSubjectMappings[c.code] || {};
    const isPrac = (mapObj.courseType === 'P' || c.courseType === 'P' || c.code.endsWith('-P'));
    const pracTeachers = (mapObj.practicalTeachers && mapObj.practicalTeachers.length > 0)
      ? mapObj.practicalTeachers
      : ((c.practicalTeachers && c.practicalTeachers.length > 0) ? c.practicalTeachers : []);
    const theoryTeachers = (mapObj.theoryTeachers && mapObj.theoryTeachers.length > 0)
      ? mapObj.theoryTeachers
      : ((c.theoryTeachers && c.theoryTeachers.length > 0) ? c.theoryTeachers : []);
    const allConfigTeachers = Array.from(new Set([...pracTeachers, ...theoryTeachers, ...(mapObj.teachers || []), ...(c.teachers || [])]));

    if (autoGenCourseFacultyBindings[c.code] === undefined || autoGenCourseFacultyBindings[c.code].length === 0) {
      autoGenCourseFacultyBindings[c.code] = allConfigTeachers.length > 0 ? allConfigTeachers : (c.teachers || []);
    }

    autoGenCourseFacultyConfig[c.code] = {
      teachers: autoGenCourseFacultyBindings[c.code],
      distribute: isPrac ? false : ((autoGenCourseFacultyConfig[c.code] && autoGenCourseFacultyConfig[c.code].distribute !== false) && autoGenCourseFacultyBindings[c.code].length > 1),
      teacherHours: mapObj.teacherHours || c.teacherHours || null,
      courseType: isPrac ? 'P' : 'T',
      practicalHours: mapObj.practicalHours !== undefined ? mapObj.practicalHours : c.practicalHours,
      theoryHours: mapObj.theoryHours !== undefined ? mapObj.theoryHours : c.theoryHours,
      practicalTeachers: pracTeachers.length > 0 ? pracTeachers : (isPrac ? autoGenCourseFacultyBindings[c.code] : []),
      theoryTeachers: theoryTeachers,
      theoryTeacherHours: mapObj.theoryTeacherHours || c.theoryTeacherHours || null
    };

    const selectedFacs = autoGenCourseFacultyBindings[c.code] || [];
    const isDistribute = !isPrac && (autoGenCourseFacultyConfig[c.code] && autoGenCourseFacultyConfig[c.code].distribute !== false);

    let summaryText = 'Auto-Assign';
    if (isPrac) {
      if (pracTeachers.length > 1) {
        summaryText = `Co-Teachers: ${pracTeachers.join(', ')} (${pracTeachers.length} in same period)`;
      } else if (selectedFacs.length > 0) {
        summaryText = `Co-Teaching: ${selectedFacs.join(', ')}`;
      }
    } else {
      if (selectedFacs.length === 1) {
        summaryText = `${selectedFacs[0]} (1 Teacher)`;
      } else if (selectedFacs.length > 1) {
        summaryText = `${selectedFacs.join(', ')} (${selectedFacs.length} Teachers)`;
      }
    }

    const typeBadge = isPrac
      ? `<span class="badge" style="background-color: var(--success-light); color: var(--success-dark); font-size: 10px;">PR</span>`
      : `<span class="badge" style="background-color: var(--warning-light); color: var(--warning-dark); font-size: 10px;">TH</span>`;

    html += `
      <div class="auto-gen-course-item" data-course-code="${c.code}" style="border-bottom: 1px dashed var(--border); padding: 8px 4px;">
        <div class="flex-row justify-between items-center" style="gap: 8px;">
          <!-- Course Checkbox & Name -->
          <div class="flex-row items-center" style="gap: 8px; flex: 1; min-width: 0;">
            <input type="checkbox" class="auto-gen-course-cb" value="${c.code}" ${currentChecked.has(c.code) ? 'checked' : ''} style="accent-color: var(--primary); width: 15px; height: 15px; cursor: pointer;">
            <div style="flex: 1; min-width: 0;">
              <div class="flex-row items-center gap-1">
                <strong style="color: var(--text-main); font-size: 13px;">${c.code}</strong> ${typeBadge}
              </div>
              <div class="text-muted" style="font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;" title="${c.name}">${c.name} (Sem ${c.semester})</div>
            </div>
          </div>

          <!-- Multi-Teacher Dropdown Trigger -->
          <div>
            <button type="button" class="btn btn-outline btn-xs btn-toggle-fac-dropdown" data-course-code="${c.code}" style="font-size: 11px; padding: 4px 8px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; border-color: ${selectedFacs.length > 0 ? 'var(--primary)' : 'var(--border)'}; background: ${selectedFacs.length > 0 ? 'var(--primary-light)' : '#ffffff'}; color: ${selectedFacs.length > 0 ? 'var(--primary)' : 'var(--text-main)'}; border-radius: 4px;">
              <i class="fa-solid fa-user-group text-primary"></i>
              <span class="fac-btn-label">${summaryText}</span>
              <i class="fa-solid fa-chevron-down" style="font-size: 9px; opacity: 0.7;"></i>
            </button>
          </div>
        </div>

        <!-- Selected Faculty Badges & Distribution indicator -->
        <div class="fac-selected-pills-row" id="fac-pills-${c.code}" style="display: ${selectedFacs.length > 0 ? 'flex' : 'none'}; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 4px; padding-left: 23px;">
          ${selectedFacs.map(fCode => `<span class="badge" style="background: #e0e7ff; color: #3730a3; font-size: 10px; padding: 2px 6px; font-weight: 700;">${fCode}</span>`).join('')}
          ${isPrac ? `<span class="badge" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 6px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-users"></i> Co-Teaching in same period</span>` : (selectedFacs.length > 1 ? `<span class="badge fac-distribute-badge" id="dist-badge-${c.code}" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 6px; font-weight: 600; display: ${isDistribute ? 'inline-flex' : 'none'}; align-items: center; gap: 4px;"><i class="fa-solid fa-shuffle"></i> Distributed</span>` : '')}
        </div>

        <!-- Popover Checklist with Checkboxes for Multiple Teachers -->
        <div class="fac-checklist-popover hidden" id="fac-popover-${c.code}" style="margin-top: 8px; margin-left: 23px; background: #ffffff; border: 1.5px solid var(--primary); border-radius: 6px; padding: 10px; box-shadow: 0 4px 14px rgba(0,0,0,0.12); font-size: 11px;">
          <div style="font-weight: 700; color: var(--text-main); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span><i class="fa-solid fa-users text-primary"></i> ${isPrac ? 'Practical Co-Teachers' : 'Select Teachers'} for ${c.code}:</span>
            <span class="text-muted" style="font-size: 10px; font-weight: normal;">${isPrac ? '(All selected co-teach together)' : '(Check multiple to share)'}</span>
          </div>

          ${deptFaculty.length > 5 ? `
            <input type="text" class="form-control form-control-sm fac-search-filter mb-2" data-course-code="${c.code}" placeholder="Filter teachers by name or code..." style="font-size: 11px; padding: 3px 6px; height: 26px;">
          ` : ''}

          <div class="fac-checkbox-list" data-course-code="${c.code}" style="max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--border); border-radius: 4px; padding: 6px; background: var(--surface);">
            ${deptFaculty.map(f => {
              const isChecked = selectedFacs.includes(f.code);
              return `
                <label class="fac-cb-item" style="display: flex; align-items: center; gap: 7px; padding: 3px 5px; cursor: pointer; border-radius: 3px; user-select: none;">
                  <input type="checkbox" class="auto-gen-fac-cb" data-course-code="${c.code}" data-fac-code="${f.code}" ${isChecked ? 'checked' : ''} style="accent-color: var(--primary); width: 14px; height: 14px; cursor: pointer;">
                  <span style="font-weight: 700; color: var(--primary); min-width: 32px;">${f.code}</span>
                  <span style="color: var(--text-main); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.name}</span>
                </label>
              `;
            }).join('')}
          </div>

          ${isPrac ? `
            <div style="margin-top: 8px; padding: 6px 8px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; color: #166534; font-size: 11px;">
              <i class="fa-solid fa-users"></i> <strong>Co-Teaching Mode:</strong> All assigned practical teachers teach together simultaneously in the same period without splitting hours. Time is credited to all selected teachers.
            </div>
          ` : `
            <div class="fac-distribute-box" id="distribute-box-${c.code}" style="display: ${selectedFacs.length > 1 ? 'block' : 'none'}; margin-top: 8px; padding: 6px 8px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px;">
              <label style="display: flex; align-items: flex-start; gap: 6px; cursor: pointer; margin: 0; color: #166534; font-weight: 600; font-size: 11px;">
                <input type="checkbox" class="auto-gen-distribute-cb" data-course-code="${c.code}" ${isDistribute ? 'checked' : ''} style="accent-color: #16a34a; width: 14px; height: 14px; margin-top: 2px;">
                <span>Distribute periods across selected teachers according to availability</span>
              </label>
            </div>
          `}

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border);">
            <button type="button" class="btn btn-outline btn-xs btn-clear-course-fac" data-course-code="${c.code}" style="font-size: 10px; padding: 2px 8px;">Clear Selection</button>
            <button type="button" class="btn btn-primary btn-xs btn-close-fac-popover" data-course-code="${c.code}" style="font-size: 10px; padding: 2px 12px;">Done</button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateSelectedCount();

  container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
    cb.addEventListener('change', updateSelectedCount);
  });

  container.querySelectorAll('.btn-toggle-fac-dropdown').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (!popover) return;
      const isOpening = popover.classList.contains('hidden');
      container.querySelectorAll('.fac-checklist-popover').forEach(p => p.classList.add('hidden'));
      if (isOpening) popover.classList.remove('hidden');
    });
  });

  container.querySelectorAll('.btn-close-fac-popover').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (popover) popover.classList.add('hidden');
    });
  });

  container.querySelectorAll('.btn-clear-course-fac').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cCode = btn.getAttribute('data-course-code');
      autoGenCourseFacultyBindings[cCode] = [];
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (popover) {
        popover.querySelectorAll('.auto-gen-fac-cb').forEach(cb => { cb.checked = false; });
      }
      updateCourseFacultyUI(cCode);
    });
  });

  container.querySelectorAll('.auto-gen-fac-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      const checkedCbs = container.querySelectorAll(`.auto-gen-fac-cb[data-course-code="${cCode}"]:checked`);
      autoGenCourseFacultyBindings[cCode] = Array.from(checkedCbs).map(c => c.getAttribute('data-fac-code'));
      updateCourseFacultyUI(cCode);
    });
  });

  container.querySelectorAll('.auto-gen-distribute-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const cCode = cb.getAttribute('data-course-code');
      if (!autoGenCourseFacultyConfig[cCode]) autoGenCourseFacultyConfig[cCode] = {};
      autoGenCourseFacultyConfig[cCode].distribute = cb.checked;
      const distBadge = document.getElementById(`dist-badge-${cCode}`);
      if (distBadge) distBadge.style.display = cb.checked ? 'inline-flex' : 'none';
    });
  });

  container.querySelectorAll('.fac-search-filter').forEach(input => {
    input.addEventListener('input', (e) => {
      const cCode = input.getAttribute('data-course-code');
      const q = e.target.value.toLowerCase().trim();
      const popover = document.getElementById(`fac-popover-${cCode}`);
      if (!popover) return;
      popover.querySelectorAll('.fac-cb-item').forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(q) ? 'flex' : 'none';
      });
    });
  });

  function updateCourseFacultyUI(cCode) {
    const selected = autoGenCourseFacultyBindings[cCode] || [];
    const btn = container.querySelector(`.btn-toggle-fac-dropdown[data-course-code="${cCode}"]`);
    const label = btn ? btn.querySelector('.fac-btn-label') : null;
    const pillsRow = document.getElementById(`fac-pills-${cCode}`);
    const distBox = document.getElementById(`distribute-box-${cCode}`);

    let text = 'Auto-Assign';
    if (selected.length === 1) {
      text = `${selected[0]} (1 Teacher)`;
    } else if (selected.length > 1) {
      text = `${selected.join(', ')} (${selected.length} Teachers)`;
    }
    if (label) label.textContent = text;

    if (btn) {
      btn.style.borderColor = selected.length > 0 ? 'var(--primary)' : 'var(--border)';
      btn.style.background = selected.length > 0 ? 'var(--primary-light)' : '#ffffff';
      btn.style.color = selected.length > 0 ? 'var(--primary)' : 'var(--text-main)';
    }

    if (pillsRow) {
      pillsRow.style.display = selected.length > 0 ? 'flex' : 'none';
      const isDist = (autoGenCourseFacultyConfig[cCode] && autoGenCourseFacultyConfig[cCode].distribute !== false);
      pillsRow.innerHTML = `
        ${selected.map(fCode => `<span class="badge" style="background: #e0e7ff; color: #3730a3; font-size: 10px; padding: 2px 6px; font-weight: 700;">${fCode}</span>`).join('')}
        ${selected.length > 1 ? `<span class="badge fac-distribute-badge" id="dist-badge-${cCode}" style="background: #dcfce7; color: #166534; font-size: 10px; padding: 2px 6px; font-weight: 600; display: ${isDist ? 'inline-flex' : 'none'}; align-items: center; gap: 4px;"><i class="fa-solid fa-shuffle"></i> Distributed</span>` : ''}
      `;
    }

    if (distBox) {
      distBox.style.display = selected.length > 1 ? 'block' : 'none';
    }
  }

  if (selectAllCb) {
    selectAllCb.onchange = () => {
      const isChecked = selectAllCb.checked;
      container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
        cb.checked = isChecked;
      });
      updateSelectedCount();
    };
  }

  // Bind change events to individual course checkboxes
  container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      updateSelectedCount();
    });
  });

  updateSelectedCount();
}

// -------------------------------------------------------------
// Auto Generation Engine Trigger & In-Section Solver (No Pop-up!)
// -------------------------------------------------------------
function getCourseExistingAllocations(cCode) {
  if (tempGeneratedAllocations && tempGeneratedAllocations[cCode] && hasAllocatedPeriods(tempGeneratedAllocations[cCode])) {
    return tempGeneratedAllocations[cCode];
  }
  if (state.allocations && state.allocations[cCode] && hasAllocatedPeriods(state.allocations[cCode])) {
    return state.allocations[cCode];
  }
  return null;
}

function hasAllocatedPeriods(alloc) {
  if (!alloc || typeof alloc !== 'object') return false;
  return Object.keys(alloc).some(day => {
    return Object.keys(alloc[day] || {}).some(p => {
      return Array.isArray(alloc[day][p]) && alloc[day][p].length > 0;
    });
  });
}

function captureCourseParamSnapshot(cCode) {
  const course = (state.courses || []).find(c => c.code === cCode) || {};
  const mapping = (typeof localSubjectMappings !== 'undefined' && localSubjectMappings[cCode]) || {};
  const cfg = (autoGenCourseFacultyConfig && autoGenCourseFacultyConfig[cCode]) || {};
  const semClean = String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();

  // 1. Recommended slots
  const recs = course.recommendations ? JSON.parse(JSON.stringify(course.recommendations)) : {};

  // 2. Assigned teachers
  let teachers = [];
  if (cfg.teachers && Array.isArray(cfg.teachers) && cfg.teachers.length > 0) teachers = cfg.teachers;
  else if (mapping.teachers && Array.isArray(mapping.teachers) && mapping.teachers.length > 0) teachers = mapping.teachers;
  else if (autoGenCourseFacultyBindings && autoGenCourseFacultyBindings[cCode]) teachers = autoGenCourseFacultyBindings[cCode];
  teachers = Array.from(new Set(teachers.filter(Boolean))).sort();

  // 3. Teacher hours split
  const teacherHours = cfg.teacherHours || mapping.teacherHours || null;
  const practicalTeachers = (cfg.practicalTeachers || mapping.practicalTeachers || []).slice().sort();
  const theoryTeachers = (cfg.theoryTeachers || mapping.theoryTeachers || []).slice().sort();

  // 4. Teacher unavailabilities
  const unavail = {};
  teachers.forEach(tCode => {
    if (state.teacherUnavailability && state.teacherUnavailability[tCode]) {
      unavail[tCode] = JSON.parse(JSON.stringify(state.teacherUnavailability[tCode]));
    }
  });

  // 5. Global / semester locked periods
  const locks = ((state.config && state.config.globalLockedPeriods) || []).filter(l => {
    const lSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return !l.semester || l.semester === 'all' || lSem === semClean.toLowerCase();
  });

  // 6. Hours and courseType
  const hours = cfg.hours || mapping.hours || course.hours || 4;
  const courseType = cfg.courseType || mapping.courseType || course.courseType || 'T';

  return {
    recs,
    teachers,
    teacherHours,
    practicalTeachers,
    theoryTeachers,
    unavail,
    locks,
    hours,
    courseType
  };
}

function detectCourseParamChanges(cCode, existingAlloc) {
  const course = (state.courses || []).find(c => c.code === cCode) || { code: cCode, name: cCode };
  const currentSnapshot = captureCourseParamSnapshot(cCode);
  const reasons = [];

  // 1. Snapshot comparison if a prior snapshot was stored
  const snapshots = state.allocatedCourseParamSnapshots || {};
  const prevSnapshot = snapshots[cCode];

  if (prevSnapshot) {
    if (JSON.stringify(prevSnapshot.recs) !== JSON.stringify(currentSnapshot.recs)) {
      reasons.push('Curriculum recommended slots (Theory / Practical) have been modified');
    }

    if (JSON.stringify(prevSnapshot.teachers) !== JSON.stringify(currentSnapshot.teachers)) {
      const prevNames = prevSnapshot.teachers.join(', ') || 'None';
      const curNames = currentSnapshot.teachers.join(', ') || 'None';
      reasons.push(`Assigned teacher(s) updated: changed from [${prevNames}] to [${curNames}]`);
    }

    if (JSON.stringify(prevSnapshot.teacherHours) !== JSON.stringify(currentSnapshot.teacherHours)) {
      reasons.push('Teacher hours distribution split updated');
    }

    if (JSON.stringify(prevSnapshot.unavail) !== JSON.stringify(currentSnapshot.unavail)) {
      reasons.push('Teacher availability or blackout periods modified for assigned faculty');
    }

    if (JSON.stringify(prevSnapshot.locks) !== JSON.stringify(currentSnapshot.locks)) {
      reasons.push('Semester blocked periods or institution locks updated');
    }

    if (prevSnapshot.hours !== currentSnapshot.hours) {
      reasons.push(`Course workload hours changed from ${prevSnapshot.hours} to ${currentSnapshot.hours} hrs`);
    }
  }

  // 2. Real-time invariants check against currently allocated periods
  // Teacher blackout clash
  const currentTeachers = currentSnapshot.teachers;
  Object.keys(existingAlloc).forEach(day => {
    Object.keys(existingAlloc[day] || {}).forEach(p => {
      const facs = existingAlloc[day][p] || [];
      facs.forEach(fCode => {
        if (state.teacherUnavailability && state.teacherUnavailability[fCode] && state.teacherUnavailability[fCode][day] && state.teacherUnavailability[fCode][day][p]) {
          const fObj = (state.faculty || []).find(f => f.code === fCode);
          const fName = fObj ? fObj.name : fCode;
          const msg = `Teacher ${fName} (${fCode}) is now marked unavailable on ${day} Period ${p}`;
          if (!reasons.includes(msg)) reasons.push(msg);
        }
      });
    });
  });

  // Blocked period clash
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const cSemClean = String(course.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
  Object.keys(existingAlloc).forEach(day => {
    Object.keys(existingAlloc[day] || {}).forEach(p => {
      const isLocked = globalLocks.some(l => {
        const lSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
        const semMatch = !l.semester || l.semester === 'all' || lSem === cSemClean;
        return l.day === day && String(l.period) === String(p) && semMatch;
      });
      if (isLocked) {
        const msg = `Allocated slot ${day} Period ${p} is now blocked for Semester ${course.semester}`;
        if (!reasons.includes(msg)) reasons.push(msg);
      }
    });
  });

  // Recommended slots missing from allocation
  if (course.recommendations) {
    Object.keys(course.recommendations).forEach(day => {
      Object.keys(course.recommendations[day] || {}).forEach(p => {
        const recType = course.recommendations[day][p];
        if (recType === 'T' || recType === 'P') {
          const isAllocated = existingAlloc[day] && existingAlloc[day][p] && existingAlloc[day][p].length > 0;
          if (!isAllocated) {
            const msg = `Recommended slot ${day} Period ${p} (${recType === 'T' ? 'Theory' : 'Practical'}) is not currently scheduled`;
            if (!reasons.includes(msg)) reasons.push(msg);
          }
        }
      });
    });
  }

  // Assigned teachers changed
  if (currentTeachers.length > 0) {
    const allocatedTeachers = new Set();
    Object.keys(existingAlloc).forEach(day => {
      Object.keys(existingAlloc[day] || {}).forEach(p => {
        (existingAlloc[day][p] || []).forEach(f => allocatedTeachers.add(f));
      });
    });
    const hasAlienTeacher = Array.from(allocatedTeachers).some(f => !currentTeachers.includes(f));
    if (hasAlienTeacher) {
      const msg = `Assigned faculty list changed from currently allocated teachers`;
      if (!reasons.includes(msg)) reasons.push(msg);
    }
  }

  // Workload hours check
  let allocatedPeriodCount = 0;
  Object.keys(existingAlloc).forEach(day => {
    Object.keys(existingAlloc[day] || {}).forEach(p => {
      if (Array.isArray(existingAlloc[day][p]) && existingAlloc[day][p].length > 0) {
        allocatedPeriodCount++;
      }
    });
  });
  if (allocatedPeriodCount > 0 && currentSnapshot.hours && allocatedPeriodCount !== currentSnapshot.hours) {
    const msg = `Allocated periods count (${allocatedPeriodCount} hrs) does not match required workload (${currentSnapshot.hours} hrs)`;
    if (!reasons.includes(msg)) reasons.push(msg);
  }

  return Array.from(new Set(reasons));
}

function showParamChangeConfirmationModal(coursesWithChanges, coursesToPreserve, forceRelaxed) {
  const modal = document.getElementById('modal-param-change-confirm');
  const container = document.getElementById('param-change-courses-list');
  if (!modal || !container) {
    const msg = coursesWithChanges.map(c => `${c.cCode} (${c.courseName}):\n- ${c.reasons.join('\n- ')}`).join('\n\n');
    if (confirm(`Parameter changes detected for previously allocated subjects:\n\n${msg}\n\nContinue and regenerate with updated parameters?`)) {
      executeAutoGenerationAfterChanges(coursesWithChanges, coursesToPreserve, forceRelaxed);
    }
    return;
  }

  container.innerHTML = coursesWithChanges.map(c => {
    return `
      <div style="background: #ffffff; border: 1.5px solid #fed7aa; border-radius: 8px; padding: 10px 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
          <strong style="font-size: 13.5px; color: #9a3412;">
            <i class="fa-solid fa-book" style="margin-right: 4px;"></i> ${escapeHtml(c.cCode)} - ${escapeHtml(c.courseName)}
          </strong>
          <span class="badge" style="background: #ea580c; color: white; font-size: 10px; font-weight: 700; padding: 2px 7px;">
            Re-allocation Required
          </span>
        </div>
        <ul style="margin: 0 0 0 16px; padding: 0; font-size: 11.5px; color: #7c2d12; line-height: 1.5;">
          ${c.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');

  modal.classList.remove('hidden');

  const btnConfirm = document.getElementById('btn-confirm-regenerate-param-change');
  const btnCancel = document.getElementById('btn-cancel-param-change');
  const btnClose = document.getElementById('btn-close-param-change-modal');

  const closeModal = () => {
    modal.classList.add('hidden');
  };

  if (btnClose) btnClose.onclick = closeModal;
  if (btnCancel) btnCancel.onclick = closeModal;

  if (btnConfirm) {
    btnConfirm.onclick = async () => {
      closeModal();
      await executeAutoGenerationAfterChanges(coursesWithChanges, coursesToPreserve, forceRelaxed);
    };
  }
}

async function executeAutoGenerationAfterChanges(coursesWithChanges, coursesToPreserve, forceRelaxed) {
  // Completely delete / clear assigned periods for courses with parameter changes
  coursesWithChanges.forEach(({ cCode }) => {
    if (tempGeneratedAllocations && tempGeneratedAllocations[cCode]) {
      delete tempGeneratedAllocations[cCode];
    }
    if (state.allocations && state.allocations[cCode]) {
      delete state.allocations[cCode];
    }
  });

  // Re-run auto generation with bypassParamCheck = true, keeping unchanged courses pinned!
  await runAutoGeneration(forceRelaxed, true, coursesToPreserve);
}

async function runAutoGeneration(forceRelaxed = false, bypassParamCheck = false, preservedCodes = null) {
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const semSelect = document.getElementById('auto-gen-sem-select');
  const pinSlotsCheck = document.getElementById('auto-gen-pin-slots');
  const btnRun = document.getElementById('btn-run-auto-generate');
  const btnApply = document.getElementById('btn-apply-auto-generate');
  const resultsCard = document.getElementById('auto-gen-results-card');
  const errBox = document.getElementById('auto-gen-error-alert');
  const suggestionsBox = document.getElementById('auto-gen-suggestions-box');
  const insectionSolver = document.getElementById('auto-gen-insection-solver');

  if (errBox) errBox.classList.add('hidden');
  if (resultsCard) resultsCard.classList.add('hidden');
  if (btnApply) btnApply.classList.add('hidden');
  if (suggestionsBox) suggestionsBox.classList.add('hidden');
  if (insectionSolver) insectionSolver.classList.add('hidden');

  // Collect Selected Courses
  const checkedBoxes = Array.from(document.querySelectorAll('.auto-gen-course-cb:checked'));
  if (checkedBoxes.length === 0) {
    if (errBox) {
      errBox.textContent = 'Please select at least one course to generate schedule.';
      errBox.classList.remove('hidden');
    }
    return;
  }
  const selectedCourseCodes = checkedBoxes.map(cb => cb.value);

  // Parameter Change Inspection for previously allocated subjects
  let coursesToPreserve = Array.isArray(preservedCodes) ? preservedCodes : [];
  if (!bypassParamCheck) {
    const coursesWithChanges = [];
    coursesToPreserve = [];

    selectedCourseCodes.forEach(cCode => {
      const existingAlloc = getCourseExistingAllocations(cCode);
      if (existingAlloc) {
        const reasons = detectCourseParamChanges(cCode, existingAlloc);
        if (reasons.length > 0) {
          const cObj = state.courses.find(c => c.code === cCode) || { code: cCode, name: cCode };
          coursesWithChanges.push({
            cCode,
            courseName: cObj.name || cCode,
            reasons
          });
        } else {
          coursesToPreserve.push(cCode);
        }
      }
    });

    if (coursesWithChanges.length > 0) {
      // Show confirmation popup with exact reasons and continue button
      showParamChangeConfirmationModal(coursesWithChanges, coursesToPreserve, forceRelaxed);
      return;
    }
  }

  // Collect Course Faculty Map & Config (With Teacher Hours Split)
  const courseFacultyMap = {};
  const courseFacultyConfig = {};

  Object.entries(autoGenCourseFacultyBindings).forEach(([cCode, facList]) => {
    if (Array.isArray(facList) && facList.length > 0) {
      courseFacultyMap[cCode] = facList;
      const mapping = localSubjectMappings[cCode] || {};
      const course = state.courses.find(c => c.code === cCode) || {};
      const courseType = mapping.courseType || course.courseType || (cCode.endsWith('-P') ? 'P' : 'T');
      const isPrac = courseType === 'P';
      const pracTeachers = isPrac
        ? (mapping.practicalTeachers && mapping.practicalTeachers.length > 0
            ? mapping.practicalTeachers
            : ((course.practicalTeachers && course.practicalTeachers.length > 0) ? course.practicalTeachers : facList))
        : [];
      const thTeachers = mapping.theoryTeachers && mapping.theoryTeachers.length > 0
        ? mapping.theoryTeachers
        : (course.theoryTeachers || []);

      courseFacultyConfig[cCode] = {
        teachers: facList,
        teacherHours: mapping.teacherHours || course.teacherHours || (autoGenCourseFacultyConfig[cCode] && autoGenCourseFacultyConfig[cCode].teacherHours) || null,
        distribute: isPrac ? false : ((autoGenCourseFacultyConfig[cCode] && autoGenCourseFacultyConfig[cCode].distribute !== false) && facList.length > 1),
        courseType: courseType,
        practicalHours: mapping.practicalHours !== undefined ? mapping.practicalHours : course.practicalHours,
        theoryHours: mapping.theoryHours !== undefined ? mapping.theoryHours : course.theoryHours,
        practicalTeachers: pracTeachers,
        theoryTeachers: thTeachers,
        theoryTeacherHours: mapping.theoryTeacherHours || course.theoryTeacherHours || null
      };
    }
  });

  // Collect Pinned Slots
  let pinnedSlots = {};
  if (pinSlotsCheck && pinSlotsCheck.checked) {
    pinnedSlots = JSON.parse(JSON.stringify(state.allocations || {}));
  }

  // Preserve allocated slots for courses with unchanged parameters
  coursesToPreserve.forEach(cCode => {
    const existingAlloc = getCourseExistingAllocations(cCode);
    if (existingAlloc) {
      pinnedSlots[cCode] = JSON.parse(JSON.stringify(existingAlloc));
    }
  });

  btnRun.disabled = true;
  btnRun.innerHTML = forceRelaxed 
    ? `<i class="fa-solid fa-spinner fa-spin"></i> Solving with Smart Exceptions...` 
    : `<i class="fa-solid fa-spinner fa-spin"></i> Solving Schedule...`;

  try {
    const res = await authFetch(`${API_BASE}/department/auto-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        semester: semSelect ? semSelect.value : '',
        courseFacultyMap,
        courseFacultyConfig,
        pinnedSlots,
        selectedCourseCodes,
        maxConsecutiveHours: 2,
        practicalBlockSize: 2,
        forceRelaxed: !!forceRelaxed
      })
    });

    const result = await res.json();
    btnRun.disabled = false;
    btnRun.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Regenerate`;

    if (res.ok && result.success) {
      tempGeneratedAllocations = result.allocations;

      // Update snapshots for all selected courses that were generated/preserved
      if (!state.allocatedCourseParamSnapshots) state.allocatedCourseParamSnapshots = {};
      selectedCourseCodes.forEach(cCode => {
        state.allocatedCourseParamSnapshots[cCode] = captureCourseParamSnapshot(cCode);
      });
      try {
        sessionStorage.setItem('allocatedCourseParamSnapshots', JSON.stringify(state.allocatedCourseParamSnapshots));
      } catch (e) {}
      
      const resultsMsg = document.getElementById('auto-gen-results-msg');
      if (result.status === 'relaxed_with_exceptions') {
        const excCount = result.exceptions ? result.exceptions.length : 0;
        let exceptionsListHtml = '';
        if (result.exceptions && result.exceptions.length > 0) {
          exceptionsListHtml = `
            <div style="margin-top: 6px; font-size: 11px; color: #92400e;">
              <strong>Applied Smart Exceptions (${excCount}):</strong>
              <ul style="margin: 2px 0 0 16px; padding: 0;">
                ${result.exceptions.map(e => `<li>${e.reason}</li>`).join('')}
              </ul>
            </div>
          `;
        }
        if (resultsMsg) {
          resultsMsg.innerHTML = `
            <span style="color: #b45309; font-weight: 700;"><i class="fa-solid fa-triangle-exclamation"></i> Feasible Schedule Generated via Smart Exceptions:</span>
            ${result.message}
            ${exceptionsListHtml}
          `;
        }
      } else {
        if (resultsMsg) resultsMsg.textContent = result.message;
      }

      document.getElementById('audit-stat-slots').textContent = result.audit.totalAllocatedSlots;
      document.getElementById('audit-stat-clashes').textContent = result.audit.facultyClashes;
      document.getElementById('audit-stat-practicals').textContent = `${result.audit.practicalBlocksPlaced} Blocks`;
      document.getElementById('audit-stat-violations').textContent = result.audit.teacherConsecutiveViolations;

      // Render suggestions if available
      if (suggestionsBox) {
        if (result.suggestions && result.suggestions.length > 0) {
          suggestionsBox.innerHTML = `
            <div style="font-weight: 600; color: #b45309; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
              <i class="fa-solid fa-lightbulb"></i> Constraint Insights & Optimizations:
            </div>
            <ul style="margin: 0; padding-left: 18px; color: #78350f; font-size: 11px; line-height: 1.5;">
              ${result.suggestions.map(s => `<li>${s}</li>`).join('')}
            </ul>
          `;
          suggestionsBox.classList.remove('hidden');
        } else {
          suggestionsBox.classList.add('hidden');
        }
      }

      if (resultsCard) resultsCard.classList.remove('hidden');
      if (btnApply) btnApply.classList.remove('hidden');

      // If triggered by "Solve with Smart Exceptions", automatically apply to timetable workspace
      if (forceRelaxed) {
        await applyAutoGeneratedSchedule();
      }
    } else {
      // In-Section Problem Statement & Bottlenecks (NO POP-UP!)
      if (insectionSolver) {
        const diag = result.diagnostics || {};
        const bottleneckFac = Object.keys(diag.bottleneckFaculty || {});
        const problemItems = [];

        if (bottleneckFac.length > 0 || (diag.rejectionCounts && diag.rejectionCounts.TEACHER_FATIGUE > 0)) {
          const facLabels = bottleneckFac.map(code => {
            const fObj = state.faculty.find(f => f.code === code);
            return fObj ? `${fObj.name} (${code})` : code;
          });
          problemItems.push(`
            <li><strong>Teacher Rest Constraints:</strong> Max 2 continuous hours limit restricted scheduling${facLabels.length > 0 ? ` for <em>${facLabels.join(', ')}</em>` : ''}.</li>
          `);
        }

        if (diag.rejectionCounts && diag.rejectionCounts.TEACHER_UNAVAILABLE > 0) {
          problemItems.push(`
            <li><strong>Teacher Blackout Periods:</strong> Blocked unwanted periods limited available free periods for assigned faculty.</li>
          `);
        }

        if (diag.rejectionCounts && diag.rejectionCounts.SHIFT_BALANCE > 0) {
          problemItems.push(`
            <li><strong>Morning/Afternoon Shift Balance:</strong> Anti-concentration shift rules prevented placing multi-hour sessions.</li>
          `);
        }

        if (diag.rejectionCounts && diag.rejectionCounts.SAME_PERIOD_REPETITION > 0) {
          problemItems.push(`
            <li><strong>Period Spread Rules:</strong> Repeated period slot exclusions constrained placement.</li>
          `);
        }

        if (diag.rejectionCounts && diag.rejectionCounts.SAME_DAY_STACKING > 0) {
          problemItems.push(`
            <li><strong>Daily Course Hour Cap:</strong> Limit of 1-2 hours per course per day reached capacity.</li>
          `);
        }

        if (problemItems.length === 0) {
          problemItems.push(`
            <li><strong>High Workload Density:</strong> Simultaneous demand for recommended slots and continuous practical blocks caused deadlocks.</li>
          `);
        }

        insectionSolver.innerHTML = `
          <div class="insection-solver-title">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>Scheduling Bottleneck & Problem Statement</span>
          </div>
          <div class="insection-solver-body">
            <p style="margin-bottom: 6px; font-weight: 600;">The strict timetable constraints could not be satisfied simultaneously:</p>
            <ul class="insection-solver-list">
              ${problemItems.join('')}
            </ul>
            <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 4px; padding: 6px 10px; color: #166534; font-size: 11px; margin-top: 8px;">
              <i class="fa-solid fa-shield-halved"></i> <strong>Hard Invariants Guaranteed:</strong> Zero teacher clashes across all departments, zero student batch clashes, lunch break strictly protected.
            </div>
          </div>
          <div class="insection-solver-actions">
            <button type="button" id="btn-insection-solve-exceptions" class="btn btn-warning btn-sm" style="font-weight: 700; background: #f59e0b; color: #78350f; border-color: #d97706; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 14px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Solve with Smart Exceptions
            </button>
          </div>
        `;
        insectionSolver.classList.remove('hidden');

        // Bind in-section solve button (NO POPUP!)
        const btnInsection = document.getElementById('btn-insection-solve-exceptions');
        if (btnInsection) {
          btnInsection.addEventListener('click', async () => {
            await runAutoGeneration(true);
          });
        }
      } else if (errBox) {
        errBox.textContent = result.message || 'Auto-generation failed under strict constraints.';
        errBox.classList.remove('hidden');
      }
    }
  } catch (err) {
    btnRun.disabled = false;
    btnRun.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Timetable`;
    if (errBox) {
      errBox.textContent = 'Connection error during automatic generation.';
      errBox.classList.remove('hidden');
    }
  }
}

async function applyAutoGeneratedSchedule() {
  if (!tempGeneratedAllocations) return;

  Object.keys(tempGeneratedAllocations).forEach(cCode => {
    state.allocations[cCode] = tempGeneratedAllocations[cCode];
    if (!state.allocatedCourseParamSnapshots) state.allocatedCourseParamSnapshots = {};
    state.allocatedCourseParamSnapshots[cCode] = captureCourseParamSnapshot(cCode);
  });
  try {
    sessionStorage.setItem('allocatedCourseParamSnapshots', JSON.stringify(state.allocatedCourseParamSnapshots));
  } catch (e) {}

  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  await saveDepartmentAllocations(false);

  closeAdvancedFeaturesModal();
  showModalAlert('Schedule Applied', 'The auto-generated schedule has been applied to your timetable workspace and saved as draft!', 'success');
}

// =============================================================
// TAB 6: Curriculum & Recommended Slots Allocation Controller
// =============================================================
let curriculumActiveToolMode = 'T'; // 'T' (Theory), 'P' (Practical), 'B' (Block), 'CLEAR'
let localCurriculumCourseRecs = {}; // { [courseCode]: { [day]: { [period]: 'T'|'P' } } }
let localCurriculumSemesterBlocks = []; // [ { day, period, semester, label: 'Blocked' } ]
let masterCoursesRecsBaseline = {}; // Pristine master timetable recommendations baseline
let curriculumSelectedSem = '';
let curriculumSelectedFilterCourse = 'ALL';

function bindCurriculumSlotAllocatorEvents() {
  // Mode selection pills
  document.querySelectorAll('.curriculum-mode-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.curriculum-mode-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      curriculumActiveToolMode = btn.getAttribute('data-mode') || 'T';
      
      const assignWrapper = document.getElementById('curriculum-assign-subject-wrapper');
      const targetLabel = document.getElementById('curriculum-target-subject-label');
      const targetSelect = document.getElementById('curriculum-target-subject-select');

      if (assignWrapper) {
        assignWrapper.style.opacity = '1';
        assignWrapper.style.pointerEvents = 'auto';
      }

      if (targetLabel) {
        if (curriculumActiveToolMode === 'T' || curriculumActiveToolMode === 'P') {
          targetLabel.innerHTML = `<i class="fa-solid fa-arrow-pointer"></i> Assign Subject:`;
          // If "ALL" was selected and user switches to T or P, auto-select first actual course
          if (targetSelect && targetSelect.value === 'ALL' && targetSelect.options.length > 1) {
            targetSelect.value = targetSelect.options[1].value;
          }
        } else if (curriculumActiveToolMode === 'B') {
          targetLabel.innerHTML = `<i class="fa-solid fa-ban"></i> Block Target:`;
        } else if (curriculumActiveToolMode === 'CLEAR') {
          targetLabel.innerHTML = `<i class="fa-solid fa-eraser"></i> Clear Target:`;
        }
      }
    });
  });

  // Semester Select
  const semSelect = document.getElementById('curriculum-sem-select');
  if (semSelect) {
    semSelect.addEventListener('change', () => {
      curriculumSelectedSem = semSelect.value;
      populateCurriculumCourseDropdowns();
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
    });
  }

  // Course Filter
  const courseFilter = document.getElementById('curriculum-course-filter');
  if (courseFilter) {
    courseFilter.addEventListener('change', () => {
      curriculumSelectedFilterCourse = courseFilter.value;
      const assignSelect = document.getElementById('curriculum-target-subject-select');
      if (assignSelect) {
        if (curriculumSelectedFilterCourse !== 'ALL') {
          assignSelect.value = curriculumSelectedFilterCourse;
        } else if (curriculumActiveToolMode === 'B' || curriculumActiveToolMode === 'CLEAR') {
          assignSelect.value = 'ALL';
        }
      }
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
    });
  }

  // Reset Button (Resets ONLY selected filter section back to master timetable recommended slots)
  const btnReset = document.getElementById('btn-reset-curriculum-slots');
  if (btnReset) {
    btnReset.addEventListener('click', async () => {
      await resetCurriculumSlotAllocations();
    });
  }

  // Save Button
  const btnSave = document.getElementById('btn-save-curriculum-slots');
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      await saveCurriculumSlotAllocations();
    });
  }
}

function initCurriculumSemesterData(force = false) {
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';

  // Initialize master baseline if not populated
  if (force || Object.keys(masterCoursesRecsBaseline).length === 0) {
    (state.courses || []).forEach(c => {
      if ((c.department || '').toUpperCase() === deptName) {
        const baseline = c.masterRecommendations || c.recommendations || {};
        masterCoursesRecsBaseline[c.code] = JSON.parse(JSON.stringify(baseline));
      }
    });
  }

  if (force || Object.keys(localCurriculumCourseRecs).length === 0) {
    localCurriculumCourseRecs = {};
    (state.courses || []).forEach(c => {
      if ((c.department || '').toUpperCase() === deptName) {
        localCurriculumCourseRecs[c.code] = c.recommendations ? JSON.parse(JSON.stringify(c.recommendations)) : {};
      }
    });
  }

  if (force || localCurriculumSemesterBlocks.length === 0) {
    localCurriculumSemesterBlocks = [];
    const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
    globalLocks.forEach(l => {
      const isBlocked = (l.label || '').toUpperCase().startsWith('BLOCKED');
      if (isBlocked && l.day && l.period) {
        localCurriculumSemesterBlocks.push({
          day: l.day.toUpperCase(),
          period: String(l.period),
          semester: String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim(),
          label: 'Blocked'
        });
      }
    });
  }

  if (force || savedCurriculumRecsSnapshot === null) {
    updateCurriculumSlotsSnapshot();
  }
}

function getCurriculumDeptCourses(sem = null) {
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  let list = (state.courses || []).filter(c => (c.department || '').toUpperCase() === deptName);
  if (sem) {
    const semClean = String(sem).replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    list = list.filter(c => {
      const cSem = String(c.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
      return cSem === semClean;
    });
  }
  return list;
}

function getCourseHourTargets(baseCode, semCourses) {
  // 1. Check localSubjectMappings if user explicitly configured hours in Subject Mapping tab
  if (typeof localSubjectMappings !== 'undefined' && localSubjectMappings[baseCode]) {
    const map = localSubjectMappings[baseCode];
    const th = map.theoryHours !== undefined ? parseInt(map.theoryHours) : null;
    const pr = map.practicalHours !== undefined ? parseInt(map.practicalHours) : null;
    if (th !== null && pr !== null && !isNaN(th) && !isNaN(pr)) {
      return { thTarget: th, prTarget: pr, total: th + pr };
    }
  }

  // 2. Check if separate -T and -P course entries exist in semCourses
  const tCourse = semCourses.find(c => c.code === `${baseCode}-T` || (c.code.startsWith(baseCode) && c.code.endsWith('-T')));
  const pCourse = semCourses.find(c => c.code === `${baseCode}-P` || (c.code.startsWith(baseCode) && c.code.endsWith('-P')));
  if (tCourse && pCourse) {
    const th = parseInt(tCourse.hours) || 2;
    const pr = parseInt(pCourse.hours) || 2;
    return { thTarget: th, prTarget: pr, total: th + pr };
  } else if (pCourse && !tCourse) {
    const pr = parseInt(pCourse.hours) || 4;
    return { thTarget: 0, prTarget: pr, total: pr };
  }

  // 3. Check single course
  const course = semCourses.find(c => {
    const b = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
    return b === baseCode;
  }) || semCourses[0];

  if (course) {
    if (course.theoryHours !== undefined && course.practicalHours !== undefined) {
      const th = parseInt(course.theoryHours) || 0;
      const pr = parseInt(course.practicalHours) || 0;
      return { thTarget: th, prTarget: pr, total: th + pr };
    }

    const totalHrs = parseInt(course.hours) || 4;
    if (course.courseType === 'P') {
      return { thTarget: 0, prTarget: totalHrs, total: totalHrs };
    }

    // Check baseline counts if available
    let origT = 0, origP = 0;
    const baselineRecs = (masterCoursesRecsBaseline && masterCoursesRecsBaseline[course.code]) || course.masterRecommendations || course.recommendations || {};
    Object.keys(baselineRecs).forEach(d => {
      Object.values(baselineRecs[d] || {}).forEach(v => {
        if (v === 'T') origT++;
        else if (v === 'P') origP++;
      });
    });

    if (origP > 0 && origP % 2 === 0) {
      return { thTarget: origT, prTarget: origP, total: origT + origP };
    }

    // Default practical split
    const split = calculateDefaultPracticalSplit(totalHrs);
    return { thTarget: split.theory, prTarget: split.practical, total: totalHrs };
  }

  return { thTarget: 4, prTarget: 0, total: 4 };
}

function getAssignedHoursForCourse(baseCode, semCourses) {
  let thAssigned = 0;
  let prAssigned = 0;
  const matchingCourses = semCourses.filter(c => {
    const b = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
    return b === baseCode;
  });

  const checkedSlots = new Set();
  matchingCourses.forEach(c => {
    const recs = localCurriculumCourseRecs[c.code] || {};
    Object.keys(recs).forEach(day => {
      Object.keys(recs[day] || {}).forEach(p => {
        const slotKey = `${day}_${p}`;
        if (!checkedSlots.has(slotKey)) {
          checkedSlots.add(slotKey);
          if (recs[day][p] === 'T') thAssigned++;
          else if (recs[day][p] === 'P') prAssigned++;
        }
      });
    });
  });

  return { thAssigned, prAssigned, totalAssigned: thAssigned + prAssigned };
}

// Determines the 2-period contiguous pair for a practical period (never crosses intervals/breaks)
function getPracticalPeriodPair(period) {
  const pStr = String(period).trim();
  // Morning block (Periods 1 & 2): before the interval between 2nd & 3rd period
  if (pStr === '1' || pStr === '2') return ['1', '2'];

  // Period 3 is bounded by intervals (between 2 & 3 and between 3 & 4) -> No practical pair can fit
  if (pStr === '3') return null;

  // Afternoon block: 4, 5, 6 (after lunch break)
  if (pStr === '4') return ['4', '5'];
  if (pStr === '5') return ['5', '6'];
  if (pStr === '6') return ['5', '6'];
  return null;
}

// Finds if clicked period is already part of a Practical pair for the given subject
function findAssignedPracticalPair(day, period, targetBaseCode, semCourses) {
  const pStr = String(period).trim();
  let isP = false;
  semCourses.forEach(c => {
    const b = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
    if (b === targetBaseCode) {
      if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day] && localCurriculumCourseRecs[c.code][day][pStr] === 'P') {
        isP = true;
      }
    }
  });
  if (!isP) return null;

  const checkSlotIsP = (pCheck) => {
    let match = false;
    semCourses.forEach(c => {
      const b = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
      if (b === targetBaseCode) {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day] && localCurriculumCourseRecs[c.code][day][pCheck] === 'P') {
          match = true;
        }
      }
    });
    return match;
  };

  // Only valid pairs: ['1', '2'], ['4', '5'], ['5', '6']
  if (pStr === '1' && checkSlotIsP('2')) return ['1', '2'];
  if (pStr === '2' && checkSlotIsP('1')) return ['1', '2'];
  if (pStr === '4' && checkSlotIsP('5')) return ['4', '5'];
  if (pStr === '5') {
    if (checkSlotIsP('4')) return ['4', '5'];
    if (checkSlotIsP('6')) return ['5', '6'];
  }
  if (pStr === '6' && checkSlotIsP('5')) return ['5', '6'];
  if (pStr === '3') return ['3'];

  return getPracticalPeriodPair(pStr);
}

function populateCurriculumSemesterDropdown() {
  const semSelect = document.getElementById('curriculum-sem-select');
  if (!semSelect) return;

  const deptCourses = getCurriculumDeptCourses();
  const pairs = [];
  deptCourses.forEach(c => {
    const prog = c.programType || 'UG';
    const s = String(c.semester || '1').replace(/^Sem(ester)?\s*/i, '').trim();
    if (!pairs.some(p => p.sem === s)) {
      pairs.push({ sem: s, prog });
    }
  });

  pairs.sort((a, b) => (parseInt(a.sem || 0) - parseInt(b.sem || 0)));

  const curVal = semSelect.value;
  semSelect.innerHTML = '';
  pairs.forEach(p => {
    const progLabel = p.prog === 'PG' ? 'MSc' : 'BSc';
    semSelect.innerHTML += `<option value="${p.sem}">Semester ${p.sem} (${progLabel})</option>`;
  });

  if (curVal && pairs.some(p => p.sem === curVal)) {
    semSelect.value = curVal;
  } else if (pairs.length > 0) {
    semSelect.value = pairs[0].sem;
  }
  curriculumSelectedSem = semSelect.value;
}

function populateCurriculumCourseDropdowns() {
  const courseFilter = document.getElementById('curriculum-course-filter');
  const targetSelect = document.getElementById('curriculum-target-subject-select');
  if (!courseFilter || !targetSelect) return;

  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  
  // Extract unique base codes
  const uniqueBases = [];
  semCourses.forEach(c => {
    const baseCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    if (!uniqueBases.some(u => u.baseCode === baseCode)) {
      uniqueBases.push({
        baseCode,
        name: c.name || baseCode,
        totalHours: c.hours || 4
      });
    }
  });

  // Filter dropdown
  const curFilterVal = courseFilter.value;
  courseFilter.innerHTML = '<option value="ALL">All Courses in Semester</option>';
  uniqueBases.forEach(u => {
    courseFilter.innerHTML += `<option value="${u.baseCode}">${escapeHtml(u.baseCode)} - ${escapeHtml(u.name)}</option>`;
  });
  if (curFilterVal && (curFilterVal === 'ALL' || uniqueBases.some(u => u.baseCode === curFilterVal))) {
    courseFilter.value = curFilterVal;
  } else {
    courseFilter.value = 'ALL';
  }
  curriculumSelectedFilterCourse = courseFilter.value;

  // Target Subject select
  const curTargetVal = targetSelect.value;
  let targetHtml = '<option value="ALL">Entire Semester (All Courses)</option>';
  uniqueBases.forEach(u => {
    targetHtml += `<option value="${u.baseCode}">${escapeHtml(u.baseCode)} - ${escapeHtml(u.name)}</option>`;
  });
  targetSelect.innerHTML = targetHtml;

  if (curTargetVal && (curTargetVal === 'ALL' || uniqueBases.some(u => u.baseCode === curTargetVal))) {
    targetSelect.value = curTargetVal;
  } else if (uniqueBases.length > 0) {
    targetSelect.value = uniqueBases[0].baseCode;
  } else {
    targetSelect.value = 'ALL';
  }

  // If active mode is T or P and "ALL" is selected, choose first course
  if ((curriculumActiveToolMode === 'T' || curriculumActiveToolMode === 'P') && targetSelect.value === 'ALL' && uniqueBases.length > 0) {
    targetSelect.value = uniqueBases[0].baseCode;
  }
}

function renderCurriculumSlotAllocator() {
  initCurriculumSemesterData();
  populateCurriculumSemesterDropdown();
  populateCurriculumCourseDropdowns();
  renderCurriculumSlotMatrix();
  renderCurriculumHoursBreakdown();
}

function renderCurriculumSlotMatrix() {
  const table = document.getElementById('table-curriculum-slots-matrix');
  if (!table) return;

  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;

  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const weekdayShort = { MONDAY: 'Monday', TUESDAY: 'Tuesday', WEDNESDAY: 'Wednesday', THURSDAY: 'Thursday', FRIDAY: 'Friday' };
  const rawPeriods = state.config.periods || ['1', '2', '3', 'LB', '4', '5', '6'];

  // Table Header
  let headerHtml = `<tr><th style="width: 120px; text-align: center; background: #f8fafc;">Day / Period</th>`;
  rawPeriods.forEach(p => {
    if (p.toUpperCase() === 'LB') {
      headerHtml += `<th style="width: 55px; background: #f1f5f9; color: var(--text-muted); font-size: 11px;">Lunch</th>`;
    } else {
      headerHtml += `<th style="min-width: 130px; text-align: center; background: #f8fafc;">Period ${p}</th>`;
    }
  });
  headerHtml += `</tr>`;
  thead.innerHTML = headerHtml;

  // Get department courses for active semester
  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const activeSemStr = String(curriculumSelectedSem).replace(/^Sem(ester)?\s*/i, '').trim();

  let totalRecCount = 0;
  let totalBlockCount = 0;
  let bodyHtml = '';

  weekdays.forEach(day => {
    bodyHtml += `<tr>`;
    bodyHtml += `<td style="font-weight: 700; background: #f8fafc; vertical-align: middle; font-size: 13px; color: var(--text-main);">${weekdayShort[day]}</td>`;

    rawPeriods.forEach(p => {
      const pUpper = p.toUpperCase();
      if (pUpper === 'LB') {
        bodyHtml += `<td style="background: #f8fafc; vertical-align: middle; color: #94a3b8; font-size: 11px; font-weight: 600; text-align: center;">Lunch</td>`;
        return;
      }

      // Check if semester is blocked
      const isSemBlocked = localCurriculumSemesterBlocks.some(b => {
        const bSem = String(b.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
        return b.day === day && String(b.period) === String(p) && bSem === activeSemStr;
      });

      if (isSemBlocked) {
        totalBlockCount++;
        bodyHtml += `
          <td class="curriculum-slot-cell slot-recommend-blocked" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="Click to toggle or clear this semester blocked slot"
              style="vertical-align: middle; height: 58px;">
            <div style="font-size: 11.5px; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 5px;">
              <i class="fa-solid fa-ban"></i> Semester Blocked
            </div>
          </td>
        `;
        return;
      }

      // Collect recommendations & blocks for courses in this slot
      const recCourses = [];
      const blockedCourses = [];

      semCourses.forEach(c => {
        const rec = (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day] && localCurriculumCourseRecs[c.code][day][p]) || '';
        const baseCode = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        if (rec === 'T' || rec === 'P') {
          if (!recCourses.some(rc => rc.baseCode === baseCode)) {
            recCourses.push({ baseCode, course: c, recType: rec });
          }
        } else if (rec === 'B') {
          if (!blockedCourses.includes(baseCode)) {
            blockedCourses.push(baseCode);
          }
        }
      });

      // Filtered mode (curriculumSelectedFilterCourse !== 'ALL')
      if (curriculumSelectedFilterCourse !== 'ALL') {
        const isThisBlocked = blockedCourses.includes(curriculumSelectedFilterCourse);
        const thisRec = recCourses.find(rc => rc.baseCode === curriculumSelectedFilterCourse);

        if (isThisBlocked) {
          totalBlockCount++;
          bodyHtml += `
            <td class="curriculum-slot-cell slot-recommend-course-blocked" 
                onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
                title="${escapeHtml(curriculumSelectedFilterCourse)} is BLOCKED in this slot. Click to unblock."
                style="vertical-align: middle; height: 58px; padding: 4px 6px;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
                <span class="badge" style="background: #ef4444; color: #ffffff; font-size: 9.5px; padding: 1px 6px; font-weight: 700; border-radius: 4px;">
                  <i class="fa-solid fa-ban"></i> Course Blocked
                </span>
                <strong style="font-size: 12px; color: #b91c1c;">${escapeHtml(curriculumSelectedFilterCourse)}</strong>
              </div>
            </td>
          `;
          return;
        }

        if (thisRec) {
          totalRecCount++;
          const badgeBg = thisRec.recType === 'T' ? 'var(--warning)' : 'var(--success)';
          const badgeLabel = thisRec.recType === 'T' ? 'Theory (TH)' : 'Practical (PR)';
          const badgeIcon = thisRec.recType === 'T' ? 'fa-book' : 'fa-flask';
          const cellClass = (thisRec.recType === 'T' ? 'slot-recommend-t' : 'slot-recommend-p');

          bodyHtml += `
            <td class="curriculum-slot-cell ${cellClass}" 
                onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
                title="${escapeHtml(thisRec.baseCode)} - ${escapeHtml(thisRec.course.name || '')} (${badgeLabel}). Click to change or toggle off."
                style="vertical-align: middle; height: 58px; padding: 4px 6px;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
                <span class="badge" style="background: ${badgeBg}; color: #ffffff; font-size: 9.5px; padding: 1px 6px; font-weight: 700; border-radius: 4px;">
                  <i class="fa-solid ${badgeIcon}"></i> ${badgeLabel}
                </span>
                <strong style="font-size: 12.5px; color: var(--text-main);">${escapeHtml(thisRec.baseCode)}</strong>
                <span style="font-size: 9.5px; color: var(--text-muted); max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(thisRec.course.name || '')}
                </span>
              </div>
            </td>
          `;
          return;
        }

        // Open slot for this filtered course
        bodyHtml += `
          <td class="curriculum-slot-cell" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="Open slot for ${escapeHtml(curriculumSelectedFilterCourse)}. Click with selected tool to assign or block."
              style="vertical-align: middle; height: 58px; background: #ffffff;">
            <div style="color: #94a3b8; font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <i class="fa-solid fa-plus opacity-40"></i> Open
            </div>
          </td>
        `;
        return;
      }

      // "ALL" Courses View Mode
      if (recCourses.length > 0) {
        totalRecCount++;
        const first = recCourses[0];
        const badgeBg = first.recType === 'T' ? 'var(--warning)' : 'var(--success)';
        const badgeLabel = first.recType === 'T' ? 'Theory (TH)' : 'Practical (PR)';
        const badgeIcon = first.recType === 'T' ? 'fa-book' : 'fa-flask';
        const cellClass = (first.recType === 'T' ? 'slot-recommend-t' : 'slot-recommend-p');

        bodyHtml += `
          <td class="curriculum-slot-cell ${cellClass}" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="${escapeHtml(first.baseCode)} - ${escapeHtml(first.course.name || '')} (${badgeLabel}). Click to change or toggle off."
              style="vertical-align: middle; height: 58px; padding: 4px 6px;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
              <span class="badge" style="background: ${badgeBg}; color: #ffffff; font-size: 9.5px; padding: 1px 6px; font-weight: 700; border-radius: 4px;">
                <i class="fa-solid ${badgeIcon}"></i> ${badgeLabel}
              </span>
              <strong style="font-size: 12.5px; color: var(--text-main);">${escapeHtml(first.baseCode)}</strong>
              <span style="font-size: 9.5px; color: var(--text-muted); max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${escapeHtml(first.course.name || '')}
              </span>
              ${blockedCourses.length > 0 ? `
                <span style="font-size: 8.5px; color: #dc2626; font-weight: 700;" title="Also blocked for: ${blockedCourses.join(', ')}">
                  <i class="fa-solid fa-ban"></i> +${blockedCourses.length} blocked
                </span>
              ` : ''}
            </div>
          </td>
        `;
      } else if (blockedCourses.length > 0) {
        totalBlockCount++;
        const blockLabel = blockedCourses.length === 1 ? `${blockedCourses[0]}` : `${blockedCourses.length} Courses`;
        const blockTitle = `Course blocked for: ${blockedCourses.join(', ')}. Click to toggle or clear.`;

        bodyHtml += `
          <td class="curriculum-slot-cell slot-recommend-course-blocked" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="${escapeHtml(blockTitle)}"
              style="vertical-align: middle; height: 58px; padding: 4px 6px;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
              <span class="badge" style="background: #ef4444; color: #ffffff; font-size: 9.5px; padding: 1px 6px; font-weight: 700; border-radius: 4px;">
                <i class="fa-solid fa-ban"></i> Course Blocked
              </span>
              <strong style="font-size: 11.5px; color: #b91c1c;">${escapeHtml(blockLabel)}</strong>
            </div>
          </td>
        `;
      } else {
        // Free / Open Slot
        bodyHtml += `
          <td class="curriculum-slot-cell" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="Open slot. Click with selected tool to assign or block."
              style="vertical-align: middle; height: 58px; background: #ffffff;">
            <div style="color: #94a3b8; font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <i class="fa-solid fa-plus opacity-40"></i> Open
            </div>
          </td>
        `;
      }
    });

    bodyHtml += `</tr>`;
  });

  tbody.innerHTML = bodyHtml;

  // Update badge stats
  const statBadge = document.getElementById('curriculum-slot-summary-stat');
  if (statBadge) {
    statBadge.textContent = `${totalRecCount} Recommended, ${totalBlockCount} Blocked`;
  }
}

function handleCurriculumSlotCellClick(day, period) {
  if (isTimetableLocked()) {
    showModalAlert('Timetable Locked', 'Cannot modify curriculum slots while department timetable is locked.', 'info');
    return;
  }

  const activeSemStr = String(curriculumSelectedSem).replace(/^Sem(ester)?\s*/i, '').trim();
  const deptCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  const assignSelect = document.getElementById('curriculum-target-subject-select');
  const targetBaseCode = assignSelect ? assignSelect.value : 'ALL';

  // 1. Tool: Block Slot ('B')
  if (curriculumActiveToolMode === 'B') {
    if (targetBaseCode && targetBaseCode !== 'ALL') {
      // Block/unblock ONLY the selected course!
      const targetCourses = deptCourses.filter(c => {
        const base = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        return base === targetBaseCode;
      });

      const isAlreadyBlocked = targetCourses.some(c => 
        localCurriculumCourseRecs[c.code] && 
        localCurriculumCourseRecs[c.code][day] && 
        localCurriculumCourseRecs[c.code][day][period] === 'B'
      );

      if (isAlreadyBlocked) {
        // Toggle OFF (unblock this course)
        targetCourses.forEach(c => {
          if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
            delete localCurriculumCourseRecs[c.code][day][period];
          }
        });
      } else {
        // Toggle ON (block this course in this slot)
        targetCourses.forEach(c => {
          if (!localCurriculumCourseRecs[c.code]) localCurriculumCourseRecs[c.code] = {};
          if (!localCurriculumCourseRecs[c.code][day]) localCurriculumCourseRecs[c.code][day] = {};
          localCurriculumCourseRecs[c.code][day][period] = 'B';
        });
      }
    } else {
      // Entire Semester Block: Toggle semester-wide blackout
      // Clear any course recommendations/blocks for this day & period in this semester
      deptCourses.forEach(c => {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });

      const existingIdx = localCurriculumSemesterBlocks.findIndex(b => {
        const bSem = String(b.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
        return b.day === day && String(b.period) === String(period) && bSem === activeSemStr;
      });

      if (existingIdx !== -1) {
        localCurriculumSemesterBlocks.splice(existingIdx, 1);
      } else {
        localCurriculumSemesterBlocks.push({
          day,
          period: String(period),
          semester: activeSemStr,
          label: 'Blocked'
        });
      }
    }

    renderCurriculumSlotMatrix();
    renderCurriculumHoursBreakdown();
    return;
  }

  // 2. Tool: Clear Slot ('CLEAR')
  if (curriculumActiveToolMode === 'CLEAR') {
    if (targetBaseCode && targetBaseCode !== 'ALL') {
      // Clear ONLY for the selected course
      const targetCourses = deptCourses.filter(c => {
        const base = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        return base === targetBaseCode;
      });
      targetCourses.forEach(c => {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });
    } else {
      // Clear entire semester block and all courses in this slot
      localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b => {
        const bSem = String(b.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
        return !(b.day === day && String(b.period) === String(period) && bSem === activeSemStr);
      });

      deptCourses.forEach(c => {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });
    }

    renderCurriculumSlotMatrix();
    renderCurriculumHoursBreakdown();
    return;
  }

  // 3. Tool: Theory Rec ('T') or Practical Rec ('P')
  if (!targetBaseCode || targetBaseCode === 'ALL') {
    showModalAlert('Select Subject', 'Please select a specific subject from the dropdown to assign Theory or Practical recommendations.', 'warning');
    return;
  }

  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const hourTargets = getCourseHourTargets(targetBaseCode, semCourses);
  const assignedHours = getAssignedHoursForCourse(targetBaseCode, semCourses);

  // A. Handling Theory Recommendation ('T')
  if (curriculumActiveToolMode === 'T') {
    // Check if slot is already 'T' for this targetBaseCode -> Toggle OFF (unassign)
    let isSameToggle = false;
    deptCourses.forEach(c => {
      const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      if (b === targetBaseCode) {
        const currentVal = (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day] && localCurriculumCourseRecs[c.code][day][period]) || '';
        if (currentVal === 'T') {
          isSameToggle = true;
        }
      }
    });

    if (isSameToggle) {
      deptCourses.forEach(c => {
        const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        if (b === targetBaseCode && localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
      return;
    }

    // Block assignment if maximum Theory hours reached!
    if (assignedHours.thAssigned >= hourTargets.thTarget) {
      showModalAlert(
        'Theory Limit Reached',
        `<strong>${escapeHtml(targetBaseCode)}</strong> has reached its maximum Theory hours (${hourTargets.thTarget} hrs).<br><span class="text-muted text-xs">Cannot assign more Theory periods for this subject. Remaining balance hours (if any) will be auto-scheduled.</span>`,
        'warning'
      );
      return;
    }

    // Remove block if slot was blocked
    localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b => {
      const bSem = String(b.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
      return !(b.day === day && String(b.period) === String(period) && bSem === activeSemStr);
    });

    // Clear ANY existing course recommendation in this slot for this semester first
    deptCourses.forEach(c => {
      if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
        delete localCurriculumCourseRecs[c.code][day][period];
      }
    });

    // Assign 'T'
    const matchingCourses = (state.courses || []).filter(c => {
      const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      return b === targetBaseCode && (c.department || '').toUpperCase() === deptName;
    });

    matchingCourses.forEach(c => {
      if (!localCurriculumCourseRecs[c.code]) localCurriculumCourseRecs[c.code] = {};
      if (!localCurriculumCourseRecs[c.code][day]) localCurriculumCourseRecs[c.code][day] = {};
      localCurriculumCourseRecs[c.code][day][period] = 'T';
    });

    renderCurriculumSlotMatrix();
    renderCurriculumHoursBreakdown();
    return;
  }

  // B. Handling Practical Recommendation ('P') - Works as 2-period contiguous PAIR
  if (curriculumActiveToolMode === 'P') {
    // Check if clicked slot is already part of an assigned Practical pair for this subject -> Toggle OFF
    const existingPair = findAssignedPracticalPair(day, period, targetBaseCode, semCourses);
    if (existingPair) {
      deptCourses.forEach(c => {
        const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        if (b === targetBaseCode && localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          existingPair.forEach(p => {
            delete localCurriculumCourseRecs[c.code][day][p];
          });
        }
      });
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
      return;
    }

    // Determine the pair of periods to assign
    const pairToAssign = getPracticalPeriodPair(period);
    if (!pairToAssign || pairToAssign.length < 2) {
      showModalAlert(
        'Interval Boundary Restricted',
        `Practical sessions cannot be allocated in <strong>Period ${escapeHtml(period)}</strong> because intervals exist between Periods 2 & 3 and Periods 3 & 4.<br><span class="text-muted text-xs">Practicals require a continuous 2-hour session (e.g. Periods 1-2, Periods 4-5, or Periods 5-6). Period 3 is reserved for 1-hour Theory slots.</span>`,
        'warning'
      );
      return;
    }

    // Block assignment if no practical hours or maximum Practical hours reached!
    if (hourTargets.prTarget <= 0) {
      showModalAlert(
        'No Practical Hours',
        `<strong>${escapeHtml(targetBaseCode)}</strong> has 0 Practical hours in its curriculum.`,
        'warning'
      );
      return;
    }

    if (assignedHours.prAssigned + 2 > hourTargets.prTarget) {
      showModalAlert(
        'Practical Limit Reached',
        `<strong>${escapeHtml(targetBaseCode)}</strong> has reached its maximum Practical hours (${hourTargets.prTarget} hrs; currently assigned: ${assignedHours.prAssigned} hrs).<br><span class="text-muted text-xs">Cannot assign another 2-hour practical pair.</span>`,
        'warning'
      );
      return;
    }

    // Remove blocks on both periods in pairToAssign
    localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b => {
      const bSem = String(b.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
      return !(b.day === day && pairToAssign.includes(String(b.period)) && bSem === activeSemStr);
    });

    // Clear ANY existing course recommendation on both periods in pairToAssign
    deptCourses.forEach(c => {
      if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
        pairToAssign.forEach(p => {
          delete localCurriculumCourseRecs[c.code][day][p];
        });
      }
    });

    // Assign 'P' to both periods in pairToAssign
    const matchingCourses = (state.courses || []).filter(c => {
      const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      return b === targetBaseCode && (c.department || '').toUpperCase() === deptName;
    });

    matchingCourses.forEach(c => {
      if (!localCurriculumCourseRecs[c.code]) localCurriculumCourseRecs[c.code] = {};
      if (!localCurriculumCourseRecs[c.code][day]) localCurriculumCourseRecs[c.code][day] = {};
      pairToAssign.forEach(p => {
        localCurriculumCourseRecs[c.code][day][p] = 'P';
      });
    });

    renderCurriculumSlotMatrix();
    renderCurriculumHoursBreakdown();
    return;
  }
}

function renderCurriculumHoursBreakdown() {
  const container = document.getElementById('curriculum-hours-summary-container');
  if (!container) return;

  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const uniqueBases = [];
  semCourses.forEach(c => {
    const baseCode = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
    if (!uniqueBases.some(u => u.baseCode === baseCode)) {
      const targets = getCourseHourTargets(baseCode, semCourses);
      uniqueBases.push({
        baseCode,
        name: c.name || baseCode,
        totalHours: targets.total,
        thTarget: targets.thTarget,
        prTarget: targets.prTarget
      });
    }
  });

  if (uniqueBases.length === 0) {
    container.innerHTML = `<span class="text-muted text-xs">No courses registered for this semester.</span>`;
    return;
  }

  let html = '';
  uniqueBases.forEach(u => {
    const assigned = getAssignedHoursForCourse(u.baseCode, semCourses);
    const thAssigned = assigned.thAssigned;
    const prAssigned = assigned.prAssigned;

    const isSelected = (curriculumSelectedFilterCourse === u.baseCode);
    const borderStyle = isSelected ? 'border: 2px solid var(--primary); background: #f0fdf4;' : 'border: 1px solid var(--border); background: #ffffff;';

    const thFull = (thAssigned >= u.thTarget);
    const prFull = (u.prTarget === 0 || prAssigned >= u.prTarget);
    const allFull = thFull && prFull;
    const remainingBalance = Math.max(0, (u.thTarget - thAssigned) + (u.prTarget - prAssigned));

    // Count blocked slots for this course
    let blockedCount = 0;
    const matchingCourses = semCourses.filter(c => {
      const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      return b === u.baseCode;
    });
    const checkedBlocked = new Set();
    matchingCourses.forEach(c => {
      const recs = localCurriculumCourseRecs[c.code] || {};
      Object.keys(recs).forEach(day => {
        Object.keys(recs[day] || {}).forEach(p => {
          const slotKey = `${day}_${p}`;
          if (!checkedBlocked.has(slotKey) && recs[day][p] === 'B') {
            checkedBlocked.add(slotKey);
            blockedCount++;
          }
        });
      });
    });

    html += `
      <div class="curriculum-hours-chip" 
           style="${borderStyle}; cursor: pointer; transition: all 0.15s ease;" 
           onclick="selectCurriculumSubjectForEdit('${u.baseCode}')"
           title="Click to select ${escapeHtml(u.baseCode)} for editing. Assigning recommended slots is optional; remaining balance hours will be auto-scheduled anywhere.">
        <div style="font-weight: 700; font-size: 11.5px; margin-right: 8px;">
          ${escapeHtml(u.baseCode)}
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span class="badge" style="background: ${thFull ? 'var(--warning)' : 'var(--warning-light)'}; color: ${thFull ? '#ffffff' : 'var(--warning-dark)'}; border: 1px solid var(--warning); font-size: 10px; padding: 1px 6px;">
            TH: ${thAssigned}/${u.thTarget} hrs
          </span>
          ${u.prTarget > 0 ? `
            <span class="badge" style="background: ${prFull ? 'var(--success)' : 'var(--success-light)'}; color: ${prFull ? '#ffffff' : 'var(--success-dark)'}; border: 1px solid var(--success); font-size: 10px; padding: 1px 6px;">
              PR: ${prAssigned}/${u.prTarget} hrs
            </span>
          ` : ''}
          ${blockedCount > 0 ? `
            <span class="badge" style="background: #fff1f2; color: #dc2626; border: 1px dashed #ef4444; font-size: 10px; padding: 1px 6px;">
              <i class="fa-solid fa-ban"></i> ${blockedCount} Blocked
            </span>
          ` : ''}
          ${allFull ? `
            <span style="font-size: 10px; font-weight: 700; color: #16a34a; display: flex; align-items: center; gap: 3px;">
              <i class="fa-solid fa-circle-check"></i> Full
            </span>
          ` : `
            <span style="font-size: 9px; color: #64748b; background: #f1f5f9; padding: 1px 5px; border-radius: 3px;" title="Remaining hours will be placed anywhere automatically during timetable generation">
              Balance: ${remainingBalance}h auto
            </span>
          `}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function selectCurriculumSubjectForEdit(baseCode) {
  const assignSelect = document.getElementById('curriculum-target-subject-select');
  const courseFilter = document.getElementById('curriculum-course-filter');
  if (assignSelect) assignSelect.value = baseCode;
  if (courseFilter) {
    courseFilter.value = baseCode;
    curriculumSelectedFilterCourse = baseCode;
  }
  renderCurriculumSlotMatrix();
  renderCurriculumHoursBreakdown();
}

// Resets ONLY the currently selected filter section back to master timetable recommended slots
async function resetCurriculumSlotAllocations() {
  if (isTimetableLocked()) {
    showModalAlert('Timetable Locked', 'Cannot reset allocations while department timetable is locked.', 'info');
    return;
  }

  const targetLabel = (curriculumSelectedFilterCourse && curriculumSelectedFilterCourse !== 'ALL')
    ? `Course ${curriculumSelectedFilterCourse}`
    : `Semester ${curriculumSelectedSem}`;

  const confirmed = confirm(
    `Reset ${targetLabel} back to master timetable recommended slots?\n\nAll user-created recommended slots and assigned subjects for this section will be removed.`
  );
  if (!confirmed) return;

  const btnReset = document.getElementById('btn-reset-curriculum-slots');
  const originalText = btnReset ? btnReset.innerHTML : 'Reset';
  if (btnReset) {
    btnReset.disabled = true;
    btnReset.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Resetting...`;
  }

  try {
    const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName : '';
    const res = await authFetch('/api/curriculum-slots/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        semester: curriculumSelectedSem,
        courseFilter: curriculumSelectedFilterCourse
      })
    });

    const data = await res.json();
    if (data.success) {
      state.courses = data.courses || state.courses;
      if (data.globalLockedPeriods) {
        if (!state.config) state.config = {};
        state.config.globalLockedPeriods = data.globalLockedPeriods;
      }

      // Re-initialize local working copy from fresh server state
      initCurriculumSemesterData(true);

      if (typeof renderAllocationMatrix === 'function') {
        renderAllocationMatrix();
      }

      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();

      showModalAlert(
        'Reset Complete',
        `Allocations for <strong>${escapeHtml(targetLabel)}</strong> have been restored to master timetable recommended slots. User-assigned slots have been removed.`,
        'success'
      );
    } else {
      showModalAlert('Reset Failed', data.message || 'Could not reset curriculum slots.', 'danger');
    }
  } catch (err) {
    console.error('Error resetting curriculum slots:', err);
    showModalAlert('Network Error', 'Connection failed while resetting curriculum slots.', 'danger');
  } finally {
    if (btnReset) {
      btnReset.disabled = false;
      btnReset.innerHTML = originalText;
    }
  }
}

async function saveCurriculumSlotAllocations() {
  if (isTimetableLocked()) {
    showModalAlert('Timetable Locked', 'Cannot save allocations while department timetable is locked.', 'info');
    return;
  }

  const btnSave = document.getElementById('btn-save-curriculum-slots');
  const originalText = btnSave ? btnSave.innerHTML : 'Save Slot Allocations';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
  }

  try {
    const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName : '';
    const res = await authFetch('/api/curriculum-slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        semester: curriculumSelectedSem,
        courseRecommendations: localCurriculumCourseRecs,
        semesterBlocks: localCurriculumSemesterBlocks
      })
    });

    const data = await res.json();
    if (data.success) {
      state.courses = data.courses || state.courses;
      if (data.globalLockedPeriods) {
        if (!state.config) state.config = {};
        state.config.globalLockedPeriods = data.globalLockedPeriods;
      }

      if (typeof renderAllocationMatrix === 'function') {
        renderAllocationMatrix();
      }

      updateCurriculumSlotsSnapshot();
      showModalAlert('Saved Successfully', 'Curriculum recommended slots and blocked periods have been saved and will be strictly respected during auto-generation!', 'success');
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
    } else {
      showModalAlert('Save Failed', data.message || 'Could not save curriculum slots.', 'danger');
    }
  } catch (err) {
    console.error('Error saving curriculum slots:', err);
    showModalAlert('Network Error', 'Connection failed while saving curriculum slots.', 'danger');
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = originalText;
    }
  }
}

// -------------------------------------------------------------
// Department Password Change (Advanced Features)
// -------------------------------------------------------------
function initDeptChangePasswordPane() {
  const deptName = state.currentDepartment || (state.currentUser && state.currentUser.departmentName) || '';
  const deptInput = document.getElementById('dept-pwd-deptname');
  if (deptInput) {
    deptInput.value = deptName;
  }
  const form = document.getElementById('form-dept-change-password');
  if (form) {
    form.reset();
    if (deptInput) deptInput.value = deptName;
  }
  const feedback = document.getElementById('dept-pwd-feedback');
  if (feedback) {
    feedback.classList.add('hidden');
    feedback.textContent = '';
  }
}

function bindDeptChangePasswordEvents() {
  // Eye icon toggles for password visibility
  document.querySelectorAll('.toggle-dept-pwd').forEach(icon => {
    icon.addEventListener('click', () => {
      const targetId = icon.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
      } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
      }
    });
  });

  const form = document.getElementById('form-dept-change-password');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = (document.getElementById('dept-current-pwd')?.value || '').trim();
      const newPassword = (document.getElementById('dept-new-pwd')?.value || '').trim();
      const confirmPassword = (document.getElementById('dept-confirm-pwd')?.value || '').trim();
      const feedback = document.getElementById('dept-pwd-feedback');
      const btnSubmit = document.getElementById('btn-submit-dept-pwd');

      const showFeedback = (msg, isError) => {
        if (!feedback) return;
        feedback.textContent = msg;
        feedback.classList.remove('hidden');
        feedback.style.background = isError ? '#fee2e2' : '#dcfce7';
        feedback.style.color = isError ? '#991b1b' : '#166534';
        feedback.style.border = isError ? '1px solid #f87171' : '1px solid #86efac';
      };

      if (!currentPassword || !newPassword) {
        showFeedback('Please fill out all password fields.', true);
        return;
      }

      if (newPassword !== confirmPassword) {
        showFeedback('New passwords do not match. Please verify and re-type.', true);
        return;
      }

      if (newPassword.length < 4) {
        showFeedback('New password must be at least 4 characters long.', true);
        return;
      }

      if (currentPassword === newPassword) {
        showFeedback('New password cannot be identical to current password.', true);
        return;
      }

      try {
        if (btnSubmit) {
          btnSubmit.disabled = true;
          btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
        }
        const deptName = state.currentDepartment || (state.currentUser && state.currentUser.departmentName) || '';
        const res = await authFetch(`${API_BASE}/department/change-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ departmentName: deptName, currentPassword, newPassword })
        });
        const result = await res.json();
        if (res.ok) {
          showFeedback('Password changed successfully! Keep your new passcode safe.', false);
          form.reset();
          const deptInput = document.getElementById('dept-pwd-deptname');
          if (deptInput) deptInput.value = deptName;
          showModalAlert('Success', `Password changed successfully for department ${deptName}.`, 'success');
        } else {
          showFeedback(result.message || 'Failed to update department password.', true);
        }
      } catch (err) {
        console.error('Password change error:', err);
        showFeedback('Network or server error while updating password.', true);
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = '<i class="fa-solid fa-key"></i> Update Password';
        }
      }
    });
  }
}





