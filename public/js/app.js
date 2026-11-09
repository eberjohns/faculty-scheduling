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
  crossDepartmentRequests: [],
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
  }, 1000);
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
  fetchVersionInfo();
  
  // Auto-refresh config, courses, and subject mappings to reflect admin lock/unlock and batch mapping changes
  window.syncGlobalConfigWithAdmin = async function() {
    if (!state.currentUser || !state.currentUser.departmentName) return;
    try {
      const ts = Date.now();
      const [cfgRes, coursesRes, mapRes, groupRes, crossDeptRes] = await Promise.all([
        fetch(`${API_BASE}/config?_t=${ts}`, { cache: 'no-store' }),
        authFetch(`${API_BASE}/courses?_t=${ts}`, { cache: 'no-store' }),
        authFetch(`${API_BASE}/department/subject-mapping?_t=${ts}`, { cache: 'no-store' }),
        authFetch(`${API_BASE}/admin/group-mappings?_t=${ts}`, { cache: 'no-store' }),
        authFetch(`${API_BASE}/cross-dept-requests?_t=${ts}`, { cache: 'no-store' })
      ]);

      let shouldRerender = false;

      if (cfgRes && cfgRes.ok) {
        const freshConfig = await cfgRes.json();
        const oldLocks = JSON.stringify((state.config && state.config.globalLockedPeriods) || []);
        const newLocks = JSON.stringify(freshConfig.globalLockedPeriods || []);
        const oldCommonBatches = JSON.stringify(state.commonBatches || []);
        const newCommonBatches = JSON.stringify(freshConfig.commonBatches || []);

        if (oldLocks !== newLocks || oldCommonBatches !== newCommonBatches) {
          state.config = freshConfig;
          state.commonBatches = freshConfig.commonBatches || [];
          shouldRerender = true;
        }
      }

      if (groupRes && groupRes.ok) {
        const freshGroups = await groupRes.json();
        const oldGroupsStr = JSON.stringify(state.groupMappings || {});
        const newGroupsStr = JSON.stringify(freshGroups || {});
        if (oldGroupsStr !== newGroupsStr) {
          state.groupMappings = freshGroups;
          shouldRerender = true;
        }
      }

      if (coursesRes && coursesRes.ok) {
        const freshCourses = await coursesRes.json();
        const oldCoursesSummary = JSON.stringify((state.courses || []).map(c => [c.code, c.mappedBatches || []]));
        const newCoursesSummary = JSON.stringify(freshCourses.map(c => [c.code, c.mappedBatches || []]));
        if (oldCoursesSummary !== newCoursesSummary || (shouldRerender && state.courses.length !== freshCourses.length)) {
          state.courses = freshCourses;
          shouldRerender = true;
        }
      }

      if (mapRes && mapRes.ok) {
        const freshMap = await mapRes.json();
        const oldMapStr = JSON.stringify(state.subjectTeacherMapping || {});
        const newMapStr = JSON.stringify(freshMap || {});
        if (oldMapStr !== newMapStr) {
          state.subjectTeacherMapping = freshMap;
          shouldRerender = true;
        }
      }

      if (crossDeptRes && crossDeptRes.ok) {
        const freshCdr = await crossDeptRes.json();
        const oldCdrStr = JSON.stringify(state.crossDepartmentRequests || []);
        const newCdrStr = JSON.stringify(freshCdr.requests || []);
        if (oldCdrStr !== newCdrStr) {
          state.crossDepartmentRequests = freshCdr.requests || [];
          updateAdvancedFeaturesNotificationBadge();
        }
      }

      if (shouldRerender) {
        renderAllocationMatrix();
        const locksBadge = document.getElementById('auto-gen-global-locks-badge');
        if (locksBadge && state.config) {
          locksBadge.textContent = `${(state.config.globalLockedPeriods || []).length} Locked`;
        }
      }
    } catch (e) {
      console.error('syncGlobalConfigWithAdmin error:', e);
    }
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
    const [configRes, deptsRes, coursesRes, facultyRes, batchesRes, groupRes, unavailRes, mappingRes, commonBatchesRes, crossDeptRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      authFetch(`${API_BASE}/courses`),
      authFetch(`${API_BASE}/faculty`),
      authFetch(`${API_BASE}/batches`),
      authFetch(`${API_BASE}/admin/group-mappings`),
      authFetch(`${API_BASE}/department/teacher-unavailability`),
      authFetch(`${API_BASE}/department/subject-mapping`),
      authFetch(`${API_BASE}/common-batches`),
      authFetch(`${API_BASE}/cross-dept-requests`)
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
    if (crossDeptRes && crossDeptRes.ok) {
      const cdrData = await crossDeptRes.json();
      state.crossDepartmentRequests = cdrData.requests || [];
    } else {
      state.crossDepartmentRequests = [];
    }
    updateAdvancedFeaturesNotificationBadge();
    // Initialize local subject mappings immediately on startup
    initLocalSubjectMappings();
  updateSubjectMappingWorkloadTracker();
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

  const linkForgotPwd = document.getElementById('link-forgot-dept-pwd');
  if (linkForgotPwd) {
    linkForgotPwd.addEventListener('click', (e) => {
      e.preventDefault();
      const selectedDept = document.getElementById('login-dept').value;
      const deptMsg = selectedDept ? ` for "${selectedDept}"` : '';
      showModalAlert(
        'Department Password Assistance',
        `Department sign-in passcodes are centrally managed by the College Timetable Administrator.\n\nIf you have forgotten your password${deptMsg}, please contact the Administrator. The admin can quickly reset or assign a new passcode for your department from the Admin Portal.`,
        'info'
      );
    });
  }

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
    updateAdvancedFeaturesNotificationBadge();
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
      const label = formatSemLabel(s);
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

  function formatSemLabel(s) {
    const romanMap = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };
    const num = parseInt(s, 10);
    if (!isNaN(num) && romanMap[num]) {
      return `${romanMap[num]} Sem`;
    }
    const baseLabel = (state.config && state.config.semesterLabels && state.config.semesterLabels[s]) || String(s || '');
    const romanMatch = baseLabel.match(/^([IVXLCDM]+)\b/i);
    if (romanMatch) {
      return `${romanMatch[1].toUpperCase()} Sem`;
    }
    return `Sem ${s}`;
  }

  function getSemesterLabel(s, program) {
    return formatSemLabel(s);
  }

  // Hook populateFilters to trigger when loading workspace
  window.formatSemLabel = formatSemLabel;
  window.populateFiltersDropdowns = populateFilters;
  window.getSemesterLabel = getSemesterLabel;
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
    if (typeof bindDeptEditorFilterEvents === 'function') bindDeptEditorFilterEvents();
    if (typeof populateDeptEditorFilterDropdowns === 'function') populateDeptEditorFilterDropdowns();
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

// Generic helper to toggle collapsible card
function setupCollapsibleCard(headerId, bodyId, btnId, storageKey, defaultCollapsed = false) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  const btn = document.getElementById(btnId);
  if (!header || !body) return;

  const savedState = storageKey ? localStorage.getItem(storageKey) : null;
  let isCollapsed = savedState !== null ? (savedState === 'true') : defaultCollapsed;

  const applyState = (collapsed) => {
    if (collapsed) {
      body.style.display = 'none';
      if (btn) {
        const textSpan = btn.querySelector('.toggle-text');
        const icon = btn.querySelector('.toggle-icon');
        if (textSpan) textSpan.textContent = 'Expand';
        if (icon) {
          icon.classList.remove('fa-chevron-up');
          icon.classList.add('fa-chevron-down');
        }
      }
    } else {
      body.style.display = '';
      if (btn) {
        const textSpan = btn.querySelector('.toggle-text');
        const icon = btn.querySelector('.toggle-icon');
        if (textSpan) textSpan.textContent = 'Collapse';
        if (icon) {
          icon.classList.remove('fa-chevron-down');
          icon.classList.add('fa-chevron-up');
        }
      }
    }
    if (storageKey) {
      localStorage.setItem(storageKey, String(collapsed));
    }
  };

  applyState(isCollapsed);

  const toggle = (e) => {
    if (e) e.stopPropagation();
    isCollapsed = !isCollapsed;
    applyState(isCollapsed);
  };

  header.addEventListener('click', toggle);
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(e);
    });
  }
}

function bindDeptEvents() {
  setupCollapsibleCard(
    'header-dept-live-workload',
    'body-dept-live-workload',
    'btn-toggle-dept-live-workload',
    'dept_live_workload_collapsed',
    false
  );
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

    let pendingImportFile = null;

    const modalFacultyMapping = document.getElementById('modal-import-faculty-mapping');
    const tbodyFacultyMapping = document.getElementById('import-faculty-mapping-tbody');
    const countFacultyMapping = document.getElementById('import-mapping-token-count');
    const btnConfirmImportMapping = document.getElementById('btn-confirm-import-faculty-mapping');
    const btnCancelImportMapping = document.getElementById('btn-cancel-import-faculty-mapping');
    const btnCloseImportMapping = document.getElementById('btn-close-import-faculty-mapping');

    function closeFacultyMappingModal() {
      if (modalFacultyMapping) modalFacultyMapping.classList.add('hidden');
      pendingImportFile = null;
      if (fileInputDept) fileInputDept.value = '';
    }

    if (btnCancelImportMapping) btnCancelImportMapping.addEventListener('click', closeFacultyMappingModal);
    if (btnCloseImportMapping) btnCloseImportMapping.addEventListener('click', closeFacultyMappingModal);

    async function executeTimetableImport(file, facultyMapping = null) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('departmentName', state.currentUser.departmentName);
      if (facultyMapping && typeof facultyMapping === 'object') {
        formData.append('facultyMapping', JSON.stringify(facultyMapping));
      }

      try {
        const res = await authFetch(`${API_BASE}/department/import-timetable`, {
          method: 'POST',
          body: formData
        });

        const result = await res.json();
        closeFacultyMappingModal();

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
        closeFacultyMappingModal();
        showModalAlert('Error', 'Connection error while uploading timetable Excel.', 'danger');
      }
    }

    if (btnConfirmImportMapping) {
      btnConfirmImportMapping.addEventListener('click', async () => {
        if (!pendingImportFile) return;

        const mapping = {};
        if (tbodyFacultyMapping) {
          const selects = tbodyFacultyMapping.querySelectorAll('.faculty-mapping-select');
          selects.forEach(sel => {
            const tok = sel.dataset.token;
            mapping[tok] = sel.value;
          });
        }

        btnConfirmImportMapping.disabled = true;
        btnConfirmImportMapping.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        try {
          await executeTimetableImport(pendingImportFile, mapping);
        } finally {
          btnConfirmImportMapping.disabled = false;
          btnConfirmImportMapping.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Confirm & Import Timetable';
        }
      });
    }

    fileInputDept.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const previewData = new FormData();
      previewData.append('file', file);
      previewData.append('departmentName', state.currentUser.departmentName);

      try {
        const previewRes = await authFetch(`${API_BASE}/department/import-timetable/preview`, {
          method: 'POST',
          body: previewData
        });

        const previewResult = await previewRes.json();

        if (!previewRes.ok || !previewResult.success) {
          fileInputDept.value = '';
          showModalAlert('Preview Error', previewResult.message || previewResult.error || 'Could not parse timetable file.', 'danger');
          return;
        }

        // If no tokens found, proceed to direct import
        if (!previewResult.tokens || previewResult.tokens.length === 0) {
          await executeTimetableImport(file);
          return;
        }

        // Store file and open mapping dialog
        pendingImportFile = file;
        const myDept = (state.currentUser.departmentName || '').toUpperCase();

        if (countFacultyMapping) {
          countFacultyMapping.textContent = previewResult.tokens.length;
        }

        if (tbodyFacultyMapping) {
          tbodyFacultyMapping.innerHTML = '';

          previewResult.tokens.forEach(tok => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--border)';

            // 1. Token Cell
            const tdToken = document.createElement('td');
            tdToken.style.padding = '10px 8px';
            tdToken.innerHTML = `<span class="badge badge-primary" style="font-size: 13px; font-weight: 700; font-family: monospace; padding: 4px 8px;">${escapeHtml(tok.token)}</span>`;

            // 2. Slots / Count Cell
            const tdCount = document.createElement('td');
            tdCount.style.padding = '10px 8px';
            tdCount.style.textAlign = 'center';
            tdCount.innerHTML = `<span class="badge badge-secondary" style="font-size: 11px;">${tok.count} slot${tok.count > 1 ? 's' : ''}</span>` +
              (tok.sampleCourses && tok.sampleCourses.length > 0 ? `<div class="text-xs text-muted" style="margin-top: 3px; font-size: 10px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(tok.sampleCourses.join(', '))}">${escapeHtml(tok.sampleCourses.join(', '))}</div>` : '');

            // 3. Select Dropdown Cell
            const tdSelect = document.createElement('td');
            tdSelect.style.padding = '10px 8px';

            const select = document.createElement('select');
            select.className = 'form-control faculty-mapping-select';
            select.style.fontSize = '12px';
            select.style.padding = '6px 10px';
            select.dataset.token = tok.token;

            // Option: Drop / Ignore
            const optDrop = document.createElement('option');
            optDrop.value = '__DROP__';
            optDrop.textContent = '-- Do Not Map (Drop / Ignore) --';
            select.appendChild(optDrop);

            // Group: Department Faculty
            const optGroupDept = document.createElement('optgroup');
            optGroupDept.label = `${myDept} Faculty (${previewResult.departmentFaculty.length})`;
            previewResult.departmentFaculty.forEach(fac => {
              const opt = document.createElement('option');
              opt.value = fac.code;
              opt.textContent = `${fac.name} (${fac.code}${fac.staffId ? ` - ${fac.staffId}` : ''})`;
              if (tok.suggestedCode && fac.code.toUpperCase() === tok.suggestedCode.toUpperCase()) {
                opt.selected = true;
              }
              optGroupDept.appendChild(opt);
            });
            select.appendChild(optGroupDept);

            // Group: Other Faculty (Cross-Dept)
            if (previewResult.otherFaculty && previewResult.otherFaculty.length > 0) {
              const optGroupOther = document.createElement('optgroup');
              optGroupOther.label = `Other Departments (${previewResult.otherFaculty.length})`;
              previewResult.otherFaculty.forEach(fac => {
                const opt = document.createElement('option');
                opt.value = fac.code;
                opt.textContent = `${fac.name} (${fac.code} - ${fac.department || ''})`;
                if (tok.suggestedCode && fac.code.toUpperCase() === tok.suggestedCode.toUpperCase() && !optGroupDept.querySelector(`option[value="${fac.code}"]`)) {
                  opt.selected = true;
                }
                optGroupOther.appendChild(opt);
              });
              select.appendChild(optGroupOther);
            }

            tdSelect.appendChild(select);

            // 4. Status Cell
            const tdStatus = document.createElement('td');
            tdStatus.style.padding = '10px 8px';
            tdStatus.style.textAlign = 'center';

            function updateStatusBadge() {
              const val = select.value;
              if (val === '__DROP__') {
                tdStatus.innerHTML = '<span class="badge badge-secondary" style="font-size: 10px;"><i class="fa-solid fa-ban"></i> Dropped</span>';
              } else if (tok.matchStatus === 'exact' && val === tok.suggestedCode) {
                tdStatus.innerHTML = '<span class="badge badge-success" style="font-size: 10px;"><i class="fa-solid fa-check"></i> Exact Code</span>';
              } else if (tok.matchStatus === 'suggested' && val === tok.suggestedCode) {
                tdStatus.innerHTML = '<span class="badge badge-primary" style="font-size: 10px;"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Matched</span>';
              } else if (tok.matchStatus === 'cross_dept' && val === tok.suggestedCode) {
                tdStatus.innerHTML = '<span class="badge badge-warning" style="font-size: 10px;"><i class="fa-solid fa-arrow-right-arrow-left"></i> Cross-Dept</span>';
              } else if (val) {
                tdStatus.innerHTML = '<span class="badge badge-info" style="font-size: 10px;"><i class="fa-solid fa-user-check"></i> Mapped</span>';
              } else {
                tdStatus.innerHTML = '<span class="badge badge-secondary" style="font-size: 10px;">Select Faculty</span>';
              }
            }

            select.addEventListener('change', updateStatusBadge);
            updateStatusBadge();

            tr.appendChild(tdToken);
            tr.appendChild(tdCount);
            tr.appendChild(tdSelect);
            tr.appendChild(tdStatus);

            tbodyFacultyMapping.appendChild(tr);
          });

          if (modalFacultyMapping) {
            modalFacultyMapping.classList.remove('hidden');
          }
        }
      } catch (err) {
        console.error(err);
        fileInputDept.value = '';
        showModalAlert('Error', 'Connection error while inspecting timetable Excel.', 'danger');
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
              const myDept = (state.currentUser.departmentName || '').toUpperCase();
              const approvedCrossReqs = (state.crossDepartmentRequests || []).filter(
                r => r.status === 'APPROVED' && (r.requestingDept || '').toUpperCase() === myDept
              );

              Object.keys(state.allocations).forEach(cCode => {
                const base = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');
                if (targetBases.has(base) || targetBases.has(cCode)) {
                  const crossForCourse = approvedCrossReqs.filter(r => {
                    const rBase = r.courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
                    const rClass = (r.courseCode.match(/(_G|_C)(\d+)/) || [])[2];
                    const cClass = (cCode.match(/(_G|_C)(\d+)/) || [])[2];
                    return r.courseCode === cCode || (rBase === base && (!rClass || !cClass || rClass === cClass));
                  });
                  if (crossForCourse.length > 0) {
                    // Retain cross-department assigned slots permanently
                    const preserved = {};
                    crossForCourse.forEach(r => {
                      (r.pinnedSlots || []).forEach(slot => {
                        const day = (slot.day || '').toUpperCase();
                        const p = String(slot.period);
                        if (!preserved[day]) preserved[day] = {};
                        preserved[day][p] = [r.assignedFacultyCode];
                      });
                    });
                    state.allocations[cCode] = preserved;
                  } else {
                    delete state.allocations[cCode];
                  }
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
      const el = document.getElementById(`calias-${c.code}`);
      const alias = el ? el.value.trim() : (c.alias || '');
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
      const el = document.getElementById(`fcode-${f.staffId}`);
      const code = el ? el.value.trim() : (f.code || '');
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
  const dUpper = (deptName || '').toUpperCase();
  let deptCourses = state.courses.filter(c => {
    const cd = (c.department || '').toUpperCase();
    if (dUpper === 'MATHEMATICS' || dUpper === 'MAT' || dUpper === 'MATH') {
      return cd === 'MATHEMATICS' || cd === 'MAT' || cd === 'MATH';
    }
    return cd === dUpper;
  });
  
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
      
      const classNumMatch = baseCode.match(/(_G|_C)(\d+)$/);
      const explicitClassNum = classNumMatch ? parseInt(classNumMatch[2], 10) : null;
      const isAlreadyClassVariant = explicitClassNum !== null;
      const count = (!isAlreadyClassVariant && classes > 1) ? classes : 1;

      for (let cl = 1; cl <= count; cl++) {
        const isCloned = !isAlreadyClassVariant && classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const inferredClass = isCloned ? cl : (explicitClassNum || (group && group > 0 ? group : null));
        const rowBatchesWeek = getCourseClassBatches(activeCourseRef, inferredClass);
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

            const cellHtml = renderCellSlot(baseCode, courseT, courseP, day, p, isCloned ? cl : (isAlreadyClassVariant ? explicitClassNum : null));
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
      
      const classNumMatch = baseCode.match(/(_G|_C)(\d+)$/);
      const explicitClassNum = classNumMatch ? parseInt(classNumMatch[2], 10) : null;
      const isAlreadyClassVariant = explicitClassNum !== null;
      const count = (!isAlreadyClassVariant && classes > 1) ? classes : 1;

      for (let cl = 1; cl <= count; cl++) {
        const isCloned = !isAlreadyClassVariant && classes > 1;
        const activeCourseRef = courseT || courseP || { code: baseCode, semester: sem, classes, group, programType: (courseT || courseP || {}).programType };
        const inferredClass = isCloned ? cl : (explicitClassNum || (group && group > 0 ? group : null));
        const rowBatches = getCourseClassBatches(activeCourseRef, inferredClass);
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

          const cellHtml = renderCellSlot(baseCode, courseT, courseP, state.selectedDay, p, isCloned ? cl : (isAlreadyClassVariant ? explicitClassNum : null));
          td.className = cellHtml.classes;
          td.innerHTML = cellHtml.html;
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      }
    });
  }

  // Synchronize open print previews or teacher timetables if visible
  syncPrintViewsIfActive();

  // Do NOT reverse-sync allocations into Subject Teacher Mapping
  // (Preserves user's configured hours, teachers, and practical/theory splits intact)
}

// Merges data representation of -T and -P suffixes
function getMergedCourseInfo(baseCode, deptCourses) {
  let courseT = deptCourses.find(c => c.code === `${baseCode}-T`);
  let courseP = deptCourses.find(c => c.code === `${baseCode}-P`);
  
  if (!courseT && !courseP) {
    const fallbackCourse = deptCourses.find(c => c.code === baseCode);
    if (fallbackCourse) {
      if (fallbackCourse.courseType === 'P') {
        courseP = fallbackCourse;
      } else {
        courseT = fallbackCourse;
      }
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
  if ((lock.day || '').toUpperCase() !== (day || '').toUpperCase()) return false;
  if (String(lock.period).trim() !== String(period).trim()) return false;

  const lockSemRaw = String(lock.semester || '').trim();
  const courseSemRaw = course ? String(course.semester || '').trim() : '';
  const isAll = !lockSemRaw || lockSemRaw.toLowerCase() === 'all';

  if (!isAll) {
    const lockDigits = lockSemRaw.replace(/\D+/g, '');
    const courseDigits = courseSemRaw.replace(/\D+/g, '');
    if (lockDigits && courseDigits && lockDigits !== courseDigits) {
      return false;
    }
    const lockProgMatch = lockSemRaw.toUpperCase().match(/UG|PG/);
    const courseProg = (course && course.programType) ? String(course.programType).toUpperCase() : '';
    const courseProgMatch = courseProg.match(/UG|PG/) || courseSemRaw.toUpperCase().match(/UG|PG/);
    if (lockProgMatch && courseProgMatch && lockProgMatch[0] !== courseProgMatch[0]) {
      return false;
    }
  }

  if (lock.department && course && course.department) {
    const lDept = String(lock.department).trim().toUpperCase();
    const cDept = String(course.department).trim().toUpperCase();
    if (lDept && cDept && lDept !== cDept) return false;
  }

  return true;
}

function getCourseCommonSubjectMatch(c) {
  if (!c) return null;
  const cat = (c.category || '').toUpperCase();
  const sem = String(c.semester || '').trim();
  const dept = (c.department || '').toUpperCase();
  const code = (c.code || '').toUpperCase();

  // Sem 1
  if (sem === '1') {
    if (cat === 'AEC' || code.includes('FA101') || code.includes('FA102') || /AEC1|AEC-1/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'AEC1';
      return 'AEC2';
    }
    if (cat === 'MDC' || code.includes('FM105') || /MDC1|MDC-1/.test(code)) return 'MDC1';
  }
  // Sem 2
  if (sem === '2') {
    if (cat === 'AEC' || /AEC3|AEC-3/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'AEC3';
      return 'AEC4';
    }
    if (cat === 'MDC' || /MDC2|MDC-2/.test(code)) return 'MDC-2';
  }
  // Sem 3
  if (sem === '3') {
    if (cat === 'VAC' || code.includes('FV108') || /VAC1|VAC-1/.test(code)) return 'VAC1';
    if (cat === 'MDC' || code.includes('FM107') || /MDC3|MDC-3/.test(code)) return 'MDC3';
  }
  // Sem 4
  if (sem === '4') {
    if (cat === 'SEC' || /SEC/.test(code)) return 'SEC';
    if (cat === 'VAC' || /VAC2|VAC-2/.test(code)) {
      if (dept === 'ENGLISH' || code.startsWith('ENG')) return 'VAC2';
      return 'VAC3';
    }
  }
  // Sem 5 SEC
  if (sem === '5' && (cat === 'SEC' || /SEC/.test(code))) return 'SEC';

  // Fallbacks by category
  if (cat === 'AEC') return sem === '2' ? 'AEC3' : 'AEC1';
  if (cat === 'MDC') return sem === '3' ? 'MDC3' : (sem === '2' ? 'MDC-2' : 'MDC1');
  if (cat === 'VAC') return sem === '4' ? 'VAC2' : 'VAC1';
  if (cat === 'SEC') return 'SEC';
  return null;
}

// Helper: Checks if a course has any curriculum recommendations defined
function courseHasRecommendations(course) {
  if (!course) return false;
  const recs = (course.recommendations && Object.keys(course.recommendations).length > 0)
    ? course.recommendations
    : (course.masterRecommendations || {});
  return Object.values(recs).some(dayObj => 
    dayObj && typeof dayObj === 'object' && Object.values(dayObj).some(val => val === 'T' || val === 'P' || val === 'B')
  );
}
window.courseHasRecommendations = courseHasRecommendations;

// Helper: Scoped course resolver by department and code/class
function findCourseForDept(code, dept) {
  if (!code) return null;
  const targetDept = (dept || (state.currentUser && state.currentUser.departmentName) || '').trim().toUpperCase();
  const cleanCode = code.replace(/-(T|P)$/, '');
  const baseCode = cleanCode.replace(/(_G|_C)\d+$/, '');

  // 1. In target dept: exact code match
  let found = (state.courses || []).find(c => (c.department || '').toUpperCase() === targetDept && c.code === code);
  if (found) return found;

  // 2. In target dept: clean code match (e.g. ENG2FA103(2)_C1)
  found = (state.courses || []).find(c => (c.department || '').toUpperCase() === targetDept && c.code === cleanCode);
  if (found) return found;

  // 3. In target dept: base code match (e.g. ENG2FA103(2))
  found = (state.courses || []).find(c => (c.department || '').toUpperCase() === targetDept && c.code === baseCode);
  if (found) return found;

  // 4. In target dept: class variant starting with baseCode
  found = (state.courses || []).find(c => (c.department || '').toUpperCase() === targetDept && (c.code.startsWith(baseCode + '_C') || c.code.startsWith(baseCode + '_G')));
  if (found) return found;

  // 5. Fallback across all courses: cleanCode
  found = (state.courses || []).find(c => c.code === cleanCode);
  if (found) return found;

  // 6. Fallback across all courses: exact or baseCode
  return (state.courses || []).find(c => c.code === code) || (state.courses || []).find(c => c.code === baseCode);
}
window.findCourseForDept = findCourseForDept;

// Universal Slot Type Resolver: determines if an assigned or recommended slot is Theory ('T'), Practical ('P'), or MDC ('M')
function determineSlotType(course, cCode, day, period, facList = [], dayAllocations = {}, deptMapping = null) {
  const codeStr = String(cCode || (course && course.code) || '').trim();
  
  // 1. Explicit suffix in course key always takes precedence
  if (codeStr.endsWith('-P') || codeStr.includes('-P_') || codeStr.includes('_P-') || codeStr.includes('-P(')) return 'P';
  if (codeStr.endsWith('-T') || codeStr.includes('-T_') || codeStr.includes('_T-') || codeStr.includes('-T(')) return 'T';

  // 1b. Explicit manual assignment type (set via manual modal when user selects Theory or Practical)
  if (typeof state !== 'undefined' && state.manualSlots) {
    const cleanB = codeStr.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const keysToCheck = [
      `${codeStr}_${day}_${period}`,
      `${cCode}_${day}_${period}`,
      `${cleanB}_${day}_${period}`
    ];
    for (const k of keysToCheck) {
      if (state.manualSlots[k] === 'P') return 'P';
      if (state.manualSlots[k] === 'T') return 'T';
    }
  }

  // 2. Curriculum Recommendation check (takes priority so recommended T/P slots receive their typical color)
  const recObj = (course && course.recommendations && course.recommendations[day])
    ? course.recommendations[day]
    : ((typeof state !== 'undefined' && Array.isArray(state.courses)) ? (state.courses.find(c => c.code === codeStr || c.code === codeStr.replace(/-(T|P)$/, ''))?.recommendations?.[day]) : null);
  if (recObj) {
    const rec = recObj[period];
    if (rec === 'P') return 'P';
    if (rec === 'T') return 'T';
    if (rec === 'B') return 'B';
    if (rec === 'M') return 'M';
  }

  // 3. Multidisciplinary / Minor category check (when slot has no explicit T/P recommendation)
  if ((course && course.courseType === 'M') || (course && course.category === 'MDC')) return 'M';

  const assignedList = Array.isArray(facList) ? facList.filter(Boolean) : [];

  // 4. Check Subject-Teacher Mapping if available (Practical IF AND ONLY IF mapped as practical, or explicit user selection)
  const baseCode = codeStr.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
  const getFromMapping = (m) => {
    if (!m) return null;
    return m[codeStr] || m[baseCode] || m[`${baseCode}-T`] || m[`${baseCode}-P`] || null;
  };
  const courseMap = deptMapping || 
    (typeof localSubjectMappings !== 'undefined' && getFromMapping(localSubjectMappings)) ||
    (typeof state !== 'undefined' && state.subjectTeacherMapping && (
      (course && course.department && getFromMapping(state.subjectTeacherMapping[course.department.toUpperCase()])) ||
      (state.currentUser && state.currentUser.departmentName && getFromMapping(state.subjectTeacherMapping[state.currentUser.departmentName.toUpperCase()])) ||
      (typeof activePrintDept !== 'undefined' && activePrintDept && getFromMapping(state.subjectTeacherMapping[activePrintDept.toUpperCase()]))
    ));

  if (courseMap) {
    // Specifically mapped as pure Practical in subject teacher mapping
    if (courseMap.courseType === 'P' || (courseMap.practicalHours > 0 && (!courseMap.theoryHours || courseMap.theoryHours === 0))) {
      return 'P';
    }
    // Specifically mapped as pure Theory in subject teacher mapping (continuous 2 hours stay Theory)
    if (courseMap.courseType === 'T' || (courseMap.theoryHours > 0 && (!courseMap.practicalHours || courseMap.practicalHours === 0))) {
      return 'T';
    }
    // Composite course with both Theory and Practical:
    if (assignedList.length > 0) {
      const isOnlyPractical = assignedList.every(f => 
        (courseMap.practicalTeachers || []).includes(f) && !(courseMap.theoryTeachers || []).includes(f)
      );
      if (isOnlyPractical) return 'P';

      const isOnlyTheory = assignedList.every(f => 
        (courseMap.theoryTeachers || []).includes(f) && !(courseMap.practicalTeachers || []).includes(f)
      );
      if (isOnlyTheory) return 'T';

      // Multiple co-teachers assigned together in slot for composite practical session
      if (assignedList.length > 1 && (courseMap.practicalHours || 0) > 0) {
        return 'P';
      }
    }
  }

  // 5. Pure course types: pure Theory (practicalHours === 0) or pure Practical (theoryHours === 0)
  const thHours = (course && typeof course.theoryHours === 'number') ? course.theoryHours : null;
  const prHours = (course && typeof course.practicalHours === 'number') ? course.practicalHours : null;

  if (thHours !== null && prHours !== null) {
    if (prHours === 0 && thHours > 0) return 'T';
    if (thHours === 0 && prHours > 0) return 'P';
  } else if (course && course.courseType === 'T') {
    return 'T';
  } else if (course && course.courseType === 'P') {
    return 'P';
  }

  // 6. Multiple co-teachers assigned together in the slot (e.g. 2+ faculty) -> Practical lab session
  if (assignedList.length > 1 && (prHours === null || prHours > 0)) {
    return 'P';
  }

  // 7. Standalone single-period or continuous theory hours without practical mapping stay Theory
  if (thHours && thHours > 0) {
    return 'T';
  }

  return (course && course.courseType === 'P') ? 'P' : 'T';
}
window.determineSlotType = determineSlotType;

// Renders the interactive contents of a grid cell
function renderCellSlot(baseCode, courseT, courseP, day, period, classIndex = null) {
  // Check if period is flagged by Admin for this course's semester & subject
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const currentCourse = courseT || courseP || findCourseForDept(baseCode);
  const courseSem = String((courseT && courseT.semester) || (courseP && courseP.semester) || (currentCourse && currentCourse.semester) || '').replace(/^Sem(ester)?\s*/i, '').trim();
  const courseSemNum = parseInt(courseSem.replace(/\D+/g, ''), 10) || 0;
  
  const hasRecs = courseHasRecommendations(courseT) || courseHasRecommendations(courseP) || courseHasRecommendations(currentCourse);

  const matchingLocks = globalLocks.filter(l => 
    isPeriodLockedForCourse(l, currentCourse, day, period, state.commonBatches || [])
  );
  // Prefer specific semester match over 'all'
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem.toLowerCase();
  }) || matchingLocks[0];

  const curRec = (currentCourse && currentCourse.recommendations && currentCourse.recommendations[day] && currentCourse.recommendations[day][period]) || '';
  const recT = (courseT && courseT.recommendations && courseT.recommendations[day] && courseT.recommendations[day][period]) ||
               (curRec === 'T' ? 'T' : '') || '';
  const recP = (courseP && courseP.recommendations && courseP.recommendations[day] && courseP.recommendations[day][period]) ||
               (curRec === 'P' ? 'P' : '') || '';
  
  const isM = (courseT && courseT.courseType === 'M') || (courseP && courseP.courseType === 'M') || (currentCourse && currentCourse.courseType === 'M');
  
  // Non-recommended slots are only locked in the first 4 semesters (Sem 1 - 4) for courses that have recommendations.
  // Courses without curriculum recommendations are fully open and can be assigned anywhere without locking.
  let highlightClass = (courseSemNum >= 5 || !hasRecs) ? '' : 'slot-recommend-none';
  let slotLabel = '';
  
  // Calculate keys for lookup based on class index if provided
  const cleanBaseCode = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumFromCode = (baseCode.match(/(_G|_C)(\d+)$/) || [])[2];
  const effClass = classIndex || classNumFromCode || (currentCourse && (currentCourse.class || currentCourse.group)) || null;

  const allCoursesList = (typeof state !== 'undefined' && Array.isArray(state.courses)) ? state.courses : [];
  const hasRealSplitT = !!allCoursesList.find(c => c.code === (cleanBaseCode + '-T') || (c.code.startsWith(cleanBaseCode + '_C') && c.code.endsWith('-T')));
  const hasRealSplitP = !!allCoursesList.find(c => c.code === (cleanBaseCode + '-P') || (c.code.startsWith(cleanBaseCode + '_C') && c.code.endsWith('-P')));

  let courseTCode = (courseT && hasRealSplitT) ? courseT.code : '';
  let coursePCode = (courseP && hasRealSplitP) ? courseP.code : '';
  if (classIndex) {
    courseTCode = (courseT && hasRealSplitT) ? `${cleanBaseCode}_C${classIndex}-T` : '';
    coursePCode = (courseP && hasRealSplitP) ? `${cleanBaseCode}_C${classIndex}-P` : '';
  } else if (effClass) {
    if (hasRealSplitT && (!courseTCode || !courseTCode.includes(`_C${effClass}`))) {
      courseTCode = courseT ? `${cleanBaseCode}_C${effClass}-T` : '';
    }
    if (hasRealSplitP && (!coursePCode || !coursePCode.includes(`_C${effClass}`))) {
      coursePCode = courseP ? `${cleanBaseCode}_C${effClass}-P` : '';
    }
  }
  
  const classDefaultCode = effClass ? `${cleanBaseCode}_C${effClass}` : baseCode;
  let activeCourseCode = courseTCode || coursePCode || classDefaultCode;

  if (recT === 'B' || recP === 'B') {
    highlightClass = 'slot-recommend-blocked';
    slotLabel = 'Blocked';
    activeCourseCode = courseTCode || coursePCode || classDefaultCode;
  } else if (recT === 'T' || recP === 'T') {
    highlightClass = 'slot-recommend-t';
    slotLabel = 'Theory Rec';
    activeCourseCode = recT === 'T' ? (courseTCode || classDefaultCode) : (coursePCode || classDefaultCode);
  } else if (recP === 'P' || recT === 'P') {
    highlightClass = 'slot-recommend-p';
    slotLabel = 'Practical Rec';
    activeCourseCode = recP === 'P' ? (coursePCode || classDefaultCode) : (courseTCode || classDefaultCode);
  } else if (curRec === 'M' || recT === 'M' || recP === 'M' || isM) {
    highlightClass = 'slot-recommend-m';
    slotLabel = '';
    activeCourseCode = courseTCode || coursePCode || classDefaultCode;
  } else {
    activeCourseCode = courseTCode || coursePCode || classDefaultCode;
    highlightClass = (courseSemNum >= 5 || !hasRecs) ? '' : 'slot-recommend-none';
    slotLabel = '';
  }

  // Load active assigned codes across candidate keys for this course/class/slot
  let candidateKeys = [];
  if (effClass) {
    candidateKeys = [
      activeCourseCode,
      courseTCode,
      coursePCode,
      `${cleanBaseCode}_C${effClass}`,
      `${cleanBaseCode}_C${effClass}-T`,
      `${cleanBaseCode}_C${effClass}-P`,
      `${cleanBaseCode}_G${effClass}`,
      `${cleanBaseCode}_G${effClass}-T`,
      `${cleanBaseCode}_G${effClass}-P`
    ].filter(Boolean);
  } else {
    candidateKeys = [
      activeCourseCode,
      courseTCode,
      coursePCode,
      baseCode,
      `${baseCode}-T`,
      `${baseCode}-P`,
      cleanBaseCode
    ].filter(Boolean);
  }

  const foundAssigned = [];
  const seenAssigned = new Set();
  candidateKeys.forEach(k => {
    if (state.allocations[k] && state.allocations[k][day] && state.allocations[k][day][period]) {
      const list = state.allocations[k][day][period];
      if (Array.isArray(list)) {
        list.forEach(fc => {
          if (fc && !seenAssigned.has(fc)) {
            seenAssigned.add(fc);
            foundAssigned.push(fc);
          }
        });
      }
    }
  });

  // Check approved cross-department requests for this course and slot
  const myDeptUpper = ((state.currentUser && state.currentUser.departmentName) || '').trim().toUpperCase();
  const approvedCross = (state.crossDepartmentRequests || []).find(r => 
    r.status === 'APPROVED' &&
    r.assignedFacultyCode &&
    (r.requestingDept || '').trim().toUpperCase() === myDeptUpper &&
    (
      r.courseCode === baseCode ||
      r.courseCode === activeCourseCode ||
      r.courseCode === cleanBaseCode ||
      (effClass && (r.courseCode === `${cleanBaseCode}_C${effClass}` || r.courseCode === `${cleanBaseCode}_G${effClass}`)) ||
      r.courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === cleanBaseCode
    ) &&
    (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period))
  );

  if (approvedCross && approvedCross.assignedFacultyCode) {
    if (!seenAssigned.has(approvedCross.assignedFacultyCode)) {
      seenAssigned.add(approvedCross.assignedFacultyCode);
      foundAssigned.push(approvedCross.assignedFacultyCode);
    }
    const crossSlot = (approvedCross.pinnedSlots || []).find(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period));
    const sType = (crossSlot && crossSlot.type) || approvedCross.courseType || 'T';
    if (sType === 'P') {
      highlightClass = 'slot-recommend-p';
      slotLabel = 'Practical Rec';
    } else {
      highlightClass = 'slot-recommend-t';
      slotLabel = 'Theory Rec';
    }
  }

  const mergedAssigned = foundAssigned;

  // When teachers are assigned, ensure Theory vs Practical coloring matches the session type
  if (mergedAssigned.length > 0 && !approvedCross) {
    const dayAllocations = {};
    const periodsList = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
    periodsList.forEach(p => {
      const dayCodes = [];
      candidateKeys.forEach(k => {
        const aList = (state.allocations[k] && state.allocations[k][day] && state.allocations[k][day][p]) || [];
        aList.forEach(c => { if (c && !dayCodes.includes(c)) dayCodes.push(c); });
      });
      if (dayCodes.length > 0) dayAllocations[p] = dayCodes;
    });

    const assignedSlotType = determineSlotType(currentCourse, activeCourseCode, day, period, mergedAssigned, dayAllocations);
    
    // Clear out default none/unassigned classes so assigned coloring applies cleanly
    highlightClass = highlightClass.replace(/\bslot-recommend-(none|t|p|m)\b/g, '').replace(/\bslot-manual-assigned-(t|p)\b/g, '').replace(/\bslot-open-assigned\b/g, '').trim();

    const slotKey = `${activeCourseCode}_${day}_${period}`;
    const cleanSlotKey = `${cleanBaseCode}_${day}_${period}`;
    const allSlotKeys = [slotKey, cleanSlotKey, `${baseCode}_${day}_${period}`, ...candidateKeys.map(k => `${k}_${day}_${period}`)];
    
    let explicitManualType = null;
    if (state.manualSlots) {
      for (const k of allSlotKeys) {
        if (state.manualSlots[k] === 'P') {
          explicitManualType = 'P';
          break;
        } else if (state.manualSlots[k] === 'T' && !explicitManualType) {
          explicitManualType = 'T';
        }
      }
    }
    const isExplicitManual = !!(explicitManualType || allSlotKeys.some(k => state.manualSlots && state.manualSlots[k]));
    const isNonRecSlot = !(hasRecs && (recT || recP || curRec));
    const isManualAssigned = isExplicitManual || isNonRecSlot;
    const effectiveSlotType = explicitManualType || assignedSlotType;

    if ((effectiveSlotType === 'M' || curRec === 'M') && recT !== 'T' && recT !== 'P' && recP !== 'P' && recP !== 'T') {
      highlightClass += ' slot-recommend-m';
      slotLabel = '';
    } else if (isManualAssigned) {
      // Manual assignment slot: Orange for Theory, Green for Practical, with BLACK leftmost line
      if (effectiveSlotType === 'P') {
        highlightClass += ' slot-manual-assigned-p';
        slotLabel = 'Practical (Manual)';
        if (coursePCode) activeCourseCode = coursePCode;
      } else if (effectiveSlotType === 'M') {
        highlightClass += ' slot-recommend-m';
        slotLabel = '';
      } else {
        highlightClass += ' slot-manual-assigned-t';
        slotLabel = 'Theory (Manual)';
        if (courseTCode) activeCourseCode = courseTCode;
      }
    } else {
      // Recommended slot: darker orange for Theory, darker green for Practical
      if (recP === 'P' || recT === 'P' || curRec === 'P' || effectiveSlotType === 'P') {
        highlightClass += ' slot-recommend-p';
        slotLabel = 'Practical Rec';
        if (coursePCode) activeCourseCode = coursePCode;
      } else {
        highlightClass += ' slot-recommend-t';
        slotLabel = 'Theory Rec';
        if (courseTCode) activeCourseCode = courseTCode;
      }
    }
  }

  // Render assigned pills with dark red crosses and tooltips
  let pillsHtml = '';
  const locked = isTimetableLocked();
  mergedAssigned.forEach(facCode => {
    const isCross = approvedCross && (approvedCross.assignedFacultyCode || '').toUpperCase() === facCode.toUpperCase();
    const facObj = state.faculty.find(f => (f.code || '').toUpperCase() === facCode.toUpperCase());
    const fullName = facObj ? facObj.name : (isCross ? approvedCross.assignedFacultyName : facCode);
    const offeringDept = isCross ? (approvedCross.offeringDept || '') : ((facObj && facObj.department && facObj.department.toUpperCase() !== myDeptUpper) ? facObj.department : '');
    const shortDept = offeringDept ? offeringDept.replace(/^Department\s+of\s+/i, '').trim() : '';

    let targetCode = activeCourseCode;
    if (courseTCode && state.allocations[courseTCode] && state.allocations[courseTCode][day] && state.allocations[courseTCode][day][period] && state.allocations[courseTCode][day][period].includes(facCode)) targetCode = courseTCode;
    else if (coursePCode && state.allocations[coursePCode] && state.allocations[coursePCode][day] && state.allocations[coursePCode][day][period] && state.allocations[coursePCode][day][period].includes(facCode)) targetCode = coursePCode;

    if (isCross) {
      pillsHtml += `
        <span class="fac-pill fac-pill-cross" title="Faculty: ${fullName} (${offeringDept}) - Cross-Department Assigned" style="background: #e0f2fe; border: 1.5px solid #0284c7; color: #0369a1; font-weight: 700; display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 4px;">
          <span>${facCode}</span>
          <span class="badge" style="background: #0284c7; color: #fff; font-size: 9px; padding: 1px 4px; border-radius: 3px;" title="${offeringDept}">${shortDept || 'Cross-Dept'}</span>
          ${locked ? '' : `<i class="fa-solid fa-lock" style="font-size: 9px; opacity: 0.7; margin-left: 2px;" title="Cross-Department teaching: can only be removed by deleting request in Advanced Features"></i>`}
        </span>
      `;
    } else {
      const crossIcon = locked ? '' : `<i class="fa-solid fa-xmark" onclick="event.stopPropagation(); unassignFaculty('${targetCode}', '${day}', '${period}', '${facCode}')"></i>`;
      pillsHtml += `
        <span class="fac-pill" title="Faculty Name: ${fullName}">
          ${facCode}
          ${crossIcon}
        </span>
      `;
    }
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

    // 1. Check mapped courses from Batch Allocation & Mapping
    const myDeptBatches = (state.allBatches || []).filter(b => {
      const bDept = (b.deptCode || b.deptName || b.department || '').trim().toUpperCase();
      return bDept === currentDeptUpper;
    });
    const myDeptBatchIds = myDeptBatches.map(b => b.batchId);

    const matchingAllocCourses = (state.courses || []).filter(c => {
      const m = getCourseCommonSubjectMatch(c);
      const cat = (c.category || '').toUpperCase();
      const semMatches = !globalLock.semester || globalLock.semester === 'all' || !c.semester || String(c.semester) === String(globalLock.semester);
      if (!semMatches) return false;
      const subjMatches = (m && (m === lockLabelNorm || m.replace(/[^A-Z0-9]/g, '') === lockClean)) || cat === lockClean || cat === lockLabelNorm;
      if (!subjMatches) return false;
      const isOffering = (c.department || '').toUpperCase() === currentDeptUpper;
      const isMapped = (c.mappedBatches || []).some(bId => myDeptBatchIds.includes(bId));
      return isOffering || isMapped;
    });

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

    // Prioritize courses specifically mapped to this row's batch or this department's student batches
    const rowBatches = (classIndex && typeof getCourseClassBatches === 'function')
      ? getCourseClassBatches(currentCourse, classIndex)
      : [];
    const rowSpecificCourses = rowBatches.length > 0
      ? matchingAllocCourses.filter(c => (c.mappedBatches || []).some(bId => rowBatches.includes(bId)))
      : [];
    const deptSpecificCourses = matchingAllocCourses.filter(c => 
      (c.mappedBatches || []).some(bId => myDeptBatchIds.includes(bId))
    );
    const finalAllocCourses = rowSpecificCourses.length > 0
      ? rowSpecificCourses
      : (deptSpecificCourses.length > 0 ? deptSpecificCourses : matchingAllocCourses);

    if (finalAllocCourses.length > 0) {
      const batchesCards = finalAllocCourses.map(c => {
        const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
        const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || 1);
        const baseCodeOnly = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const isExternal = (c.department || '').toUpperCase() !== currentDeptUpper;
        const offeringNotice = isExternal ? `<div style="font-size: 8px; color: #0284c7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;"><i class="fa-solid fa-school" style="font-size: 7px;"></i> From ${escapeHtml(c.department)}</div>` : '';

        // Look up assigned teacher in the offering department's Subject Teacher Mapping
        const deptUpper = (c.department || '').toUpperCase();
        const teacherMap = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptUpper] && state.subjectTeacherMapping[deptUpper][c.code]) || null;
        let teacherDisplay = 'Pending Dept Mapping';
        if (teacherMap) {
          const tCodes = [...new Set([...(teacherMap.teachers || []), ...(teacherMap.theoryTeachers || []), ...(teacherMap.practicalTeachers || [])])];
          if (tCodes.length > 0) {
            const labels = tCodes.map(tc => {
              const f = (state.faculty || []).find(x => x.code === tc);
              return f ? `${tc} (${f.name})` : tc;
            });
            teacherDisplay = labels.join(', ');
          }
        }

        return `
          <div class="common-batch-slot-card" style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 4px; padding: 2px 4px; margin-top: 2px; text-align: left; font-size: 9.5px; line-height: 1.25;" title="Course: ${escapeHtml(baseCodeOnly)} | Class: C${classNum} | Teacher: ${escapeHtml(teacherDisplay)}">
            <div style="font-weight: 700; color: #1d4ed8; display: flex; align-items: center; justify-content: space-between; gap: 2px;">
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 68%;"><i class="fa-solid fa-book" style="font-size: 8px;"></i> ${escapeHtml(baseCodeOnly)}</span>
              <span style="font-size: 8px; background: #dbeafe; color: #1e40af; padding: 0 3px; border-radius: 2px; font-weight: 700;">Class C${classNum}</span>
            </div>
            <div style="color: #1e3a8a; font-size: 8.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              <i class="fa-solid fa-chalkboard-user" style="font-size: 7.5px;"></i> ${escapeHtml(teacherDisplay)}
            </div>
            ${offeringNotice}
          </div>
        `;
      }).join('');

      lockFlagBadge = `
        <div class="admin-lock-tag" title="Common Activity: ${globalLock.label || 'Locked Period'}" style="font-size: 9px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; display: flex; align-items: center; justify-content: space-between;">
          <span><i class="fa-solid fa-lock" style="font-size: 8px;"></i> ${globalLock.label}</span>
          <span style="font-size: 8px; background: #fde68a; padding: 0 3px; border-radius: 2px;">${finalAllocCourses.length} Class${finalAllocCourses.length === 1 ? '' : 'es'}</span>
        </div>
        ${batchesCards}
      `;
    } else if (matchingDeptBatches.length > 0) {
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
  const course = findCourseForDept(activeCourseCode) || findCourseForDept(baseCode);
  const courseSem = course ? String(course.semester).replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase() : '';
  const courseSemNum = course ? (parseInt(String(course.semester).replace(/\D+/g, ''), 10) || 0) : 0;
  const hasRecs = courseHasRecommendations(course);
  
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

  // Unrecommended slot lock only exists in the first 4 semesters (Sem 1 - 4) for courses that have recommendations
  if (hasRecs && cell.classList.contains('slot-recommend-none') && courseSemNum < 5) {
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

// Helper to find the next right teaching period in order on a day
function getNextRightPeriod(period) {
  const allPeriods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
  const teachingPeriods = allPeriods.filter(p => String(p).toUpperCase() !== 'LB');
  const idx = teachingPeriods.map(p => String(p).trim()).indexOf(String(period).trim());
  if (idx !== -1 && idx + 1 < teachingPeriods.length) {
    return teachingPeriods[idx + 1];
  }
  return null;
}

// Global active slot context
let activeSlotContext = null;

window.setManualAssignType = async function(type) {
  if (!activeSlotContext) return;
  if (isTimetableLocked()) return;
  const { period, day, courseCode, baseCode } = activeSlotContext;
  const nextPeriod = getNextRightPeriod(period);
  if (type === 'P' && !nextPeriod) {
    showModalAlert('No Next Slot', `Cannot allocate a 2-period practical session starting at Period ${period} because it is the last period of the day.`, 'warning');
    return;
  }
  activeSlotContext.assignmentType = type;

  // Update button active states in UI: selected Theory is orange, selected Practical is green, unselected is normal
  const btnT = document.getElementById('btn-manual-assign-type-theory');
  const btnP = document.getElementById('btn-manual-assign-type-practical');
  if (btnT && btnP) {
    if (type === 'T') {
      btnT.className = 'btn btn-xs btn-assign-type-theory active';
      btnP.className = 'btn btn-xs btn-assign-type-practical';
    } else {
      btnT.className = 'btn btn-xs btn-assign-type-theory';
      btnP.className = 'btn btn-xs btn-assign-type-practical active';
    }
  }

  // Update details badge
  const badge = document.getElementById('fac-select-type-badge');
  if (badge) {
    if (type === 'T') {
      badge.className = 'badge badge-warning';
      badge.textContent = `Theory (1 Slot: P${period})`;
    } else {
      badge.className = 'badge badge-success';
      badge.textContent = `Practical (2 Slots: P${period} + P${nextPeriod})`;
    }
  }

  // Probe all possible keys to see if this slot is already assigned
  const allCoursesList = (typeof state !== 'undefined' && Array.isArray(state.courses)) ? state.courses : [];
  const cleanBase = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumMatch = (courseCode || baseCode).match(/(_G|_C)(\d+)/);
  const effClass = classNumMatch ? parseInt(classNumMatch[2]) : null;
  const classSuffix = effClass ? `_C${effClass}` : '';
  const hasRealSplitT = !!allCoursesList.find(c => c.code === (cleanBase + '-T') || (c.code.startsWith(cleanBase + '_C') && c.code.endsWith('-T')));
  const hasRealSplitP = !!allCoursesList.find(c => c.code === (cleanBase + '-P') || (c.code.startsWith(cleanBase + '_C') && c.code.endsWith('-P')));

  const keysToTry = [
    courseCode,
    `${courseCode}-T`,
    `${courseCode}-P`,
    courseCode.replace(/-(T|P)$/, ''),
    cleanBase,
    `${cleanBase}${classSuffix}`,
    `${cleanBase}${classSuffix}-T`,
    `${cleanBase}${classSuffix}-P`
  ];

  const currentAssigned = [];
  keysToTry.forEach(k => {
    const list = state.allocations[k]?.[day]?.[period] || [];
    if (Array.isArray(list)) {
      list.forEach(fc => {
        if (fc && !currentAssigned.includes(fc)) currentAssigned.push(fc);
      });
    }
  });

  // If faculty is currently assigned in this slot, directly update the assigned state
  if (currentAssigned.length > 0) {
    if (type === 'T') {
      // 1. Mark this slot as Theory in manualSlots
      if (!state.manualSlots) state.manualSlots = {};
      keysToTry.forEach(k => {
        state.manualSlots[`${k}_${day}_${period}`] = 'T';
      });

      // 2. If split codes, move assigned faculty on this slot from -P to -T
      if (hasRealSplitT && hasRealSplitP) {
        const pCode = `${cleanBase}${classSuffix}-P`;
        const tCode = `${cleanBase}${classSuffix}-T`;
        if (!state.allocations[tCode]) state.allocations[tCode] = {};
        if (!state.allocations[tCode][day]) state.allocations[tCode][day] = {};
        if (!state.allocations[tCode][day][period]) state.allocations[tCode][day][period] = [];

        currentAssigned.forEach(fc => {
          if (!state.allocations[tCode][day][period].includes(fc)) {
            state.allocations[tCode][day][period].push(fc);
          }
          if (state.allocations[pCode]?.[day]?.[period]) {
            state.allocations[pCode][day][period] = state.allocations[pCode][day][period].filter(c => c !== fc);
          }
        });
      }

      try {
        const dept = state.currentUser ? state.currentUser.departmentName : '';
        sessionStorage.setItem(`manualSlots_${dept}`, JSON.stringify(state.manualSlots));
      } catch(e) {}

      syncAllocationsToSubjectMapping(courseCode);
      renderFacultySelectList();
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      triggerAutosave();
    } else if (type === 'P') {
      // Changing to Practical: requires continuous nextPeriod
      const targetCourseCode = (hasRealSplitP) ? `${cleanBase}${classSuffix}-P` : (effClass ? `${cleanBase}${classSuffix}` : courseCode);
      
      // Validate nextPeriod for each assigned faculty member
      for (const fc of currentAssigned) {
        if (checkLocalClash(fc, day, nextPeriod, targetCourseCode)) {
          showModalAlert(
            'Hard Booking Clash!',
            `Cannot change to Practical: Faculty member '${fc}' is already allocated to another course on ${day} Period ${nextPeriod}.`,
            'danger'
          );
          // Revert button UI to Theory
          if (btnT && btnP) {
            btnT.className = 'btn btn-xs btn-assign-type-theory active';
            btnP.className = 'btn btn-xs btn-assign-type-practical';
          }
          if (badge) {
            badge.className = 'badge badge-warning';
            badge.textContent = `Theory (1 Slot: P${period})`;
          }
          activeSlotContext.assignmentType = 'T';
          renderFacultySelectList();
          return;
        }

        const unavailList = (state.teacherUnavailability && state.teacherUnavailability[fc]) || [];
        const isUnavail = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(nextPeriod)));
        if (isUnavail) {
          showModalAlert(
            'Unavailable Slot',
            `Cannot change to Practical: Faculty member '${fc}' marked ${day} Period ${nextPeriod} as unavailable.`,
            'danger'
          );
          if (btnT && btnP) {
            btnT.className = 'btn btn-xs btn-assign-type-theory active';
            btnP.className = 'btn btn-xs btn-assign-type-practical';
          }
          if (badge) {
            badge.className = 'badge badge-warning';
            badge.textContent = `Theory (1 Slot: P${period})`;
          }
          activeSlotContext.assignmentType = 'T';
          renderFacultySelectList();
          return;
        }
      }

      // Mark both slots as Practical in manualSlots
      if (!state.manualSlots) state.manualSlots = {};
      [period, nextPeriod].forEach(p => {
        keysToTry.forEach(k => {
          state.manualSlots[`${k}_${day}_${p}`] = 'P';
        });
      });

      // Assign to allocations
      if (hasRealSplitT && hasRealSplitP) {
        const pCode = `${cleanBase}${classSuffix}-P`;
        const tCode = `${cleanBase}${classSuffix}-T`;
        if (!state.allocations[pCode]) state.allocations[pCode] = {};
        if (!state.allocations[pCode][day]) state.allocations[pCode][day] = {};

        [period, nextPeriod].forEach(p => {
          if (!state.allocations[pCode][day][p]) state.allocations[pCode][day][p] = [];
          currentAssigned.forEach(fc => {
            if (!state.allocations[pCode][day][p].includes(fc)) {
              state.allocations[pCode][day][p].push(fc);
            }
            if (state.allocations[tCode]?.[day]?.[p]) {
              state.allocations[tCode][day][p] = state.allocations[tCode][day][p].filter(c => c !== fc);
            }
          });
        });
      } else {
        const destCode = effClass ? `${cleanBase}${classSuffix}` : courseCode;
        if (!state.allocations[destCode]) state.allocations[destCode] = {};
        if (!state.allocations[destCode][day]) state.allocations[destCode][day] = {};
        if (!state.allocations[destCode][day][nextPeriod]) state.allocations[destCode][day][nextPeriod] = [];
        currentAssigned.forEach(fc => {
          if (!state.allocations[destCode][day][nextPeriod].includes(fc)) {
            state.allocations[destCode][day][nextPeriod].push(fc);
          }
        });
      }

      try {
        const dept = state.currentUser ? state.currentUser.departmentName : '';
        sessionStorage.setItem(`manualSlots_${dept}`, JSON.stringify(state.manualSlots));
      } catch(e) {}

      syncAllocationsToSubjectMapping(courseCode);
      renderFacultySelectList();
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      triggerAutosave();
    }
  } else {
    // Unassigned slot: just refresh faculty list for 1 vs 2 slots
    renderFacultySelectList();
  }
};

window.openFacultySelectModal = function(baseCode, courseCode, day, period, cellElement) {
  const course = findCourseForDept(courseCode) || findCourseForDept(baseCode);
  const classNumMatch = (courseCode || baseCode).match(/(_G|_C)(\d+)/);
  const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (course ? (course.class || course.group || 0) : 0);
  const mappedBatches = course ? course.mappedBatches : [];
  const cleanBase = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const formattedCode = formatCourseCodeWithGroup(cleanBase, classNum, mappedBatches);
  
  const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCode] || localSubjectMappings[baseCodeForRec] || {};
  const slotKey = `${courseCode}_${day}_${period}`;
  const baseSlotKey = `${baseCode}_${day}_${period}`;
  const cleanSlotKey = `${cleanBase}_${day}_${period}`;
  const isPracRecorded = !!(state.manualSlots && (state.manualSlots[slotKey] === 'P' || state.manualSlots[baseSlotKey] === 'P' || state.manualSlots[cleanSlotKey] === 'P'));
  const isTheoryRecorded = !!(state.manualSlots && (state.manualSlots[slotKey] === 'T' || state.manualSlots[baseSlotKey] === 'T' || state.manualSlots[cleanSlotKey] === 'T'));
  const isMappedPractical = (mData.courseType === 'P') || (course && course.courseType === 'P') || courseCode.endsWith('-P') || ((course && course.recommendations && course.recommendations[day] && course.recommendations[day][period]) === 'P');

  const effClassForModal = classNumMatch ? parseInt(classNumMatch[2]) : (course ? (course.class || course.group || 0) : 0);
  const classSuffixForModal = effClassForModal ? `_C${effClassForModal}` : '';
  const isAssignedP = !!(
    (state.allocations[`${cleanBase}${classSuffixForModal}-P`]?.[day]?.[period]?.length > 0) ||
    (courseCode.endsWith('-P') && state.allocations[courseCode]?.[day]?.[period]?.length > 0) ||
    (state.allocations[`${baseCode}-P`]?.[day]?.[period]?.length > 0)
  );
  const isAssignedT = !!(
    (state.allocations[`${cleanBase}${classSuffixForModal}-T`]?.[day]?.[period]?.length > 0) ||
    (courseCode.endsWith('-T') && state.allocations[courseCode]?.[day]?.[period]?.length > 0) ||
    (state.allocations[`${baseCode}-T`]?.[day]?.[period]?.length > 0)
  );
  
  const nextPeriod = getNextRightPeriod(period);
  // Default to Practical (2 slots) only if mapped as practical or previously recorded/assigned as practical. Otherwise default to Theory (1 slot).
  let initialType = 'T';
  if (nextPeriod) {
    if (isPracRecorded || isAssignedP) {
      initialType = 'P';
    } else if (isTheoryRecorded || isAssignedT) {
      initialType = 'T';
    } else if (isMappedPractical) {
      initialType = 'P';
    }
  }

  activeSlotContext = { baseCode, courseCode, day, period, cell: cellElement, assignmentType: initialType };

  const pracTeachers = (mData.practicalTeachers && mData.practicalTeachers.length > 0)
    ? mData.practicalTeachers
    : ((course && course.practicalTeachers && course.practicalTeachers.length > 0) ? course.practicalTeachers : []);

  let detailsHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:10px;">
      <div>Course: <strong>${formattedCode}</strong> <span id="fac-select-type-badge" class="badge ${initialType === 'P' ? 'badge-success' : 'badge-warning'}">${initialType === 'P' ? `Practical (2 Slots: P${period} + P${nextPeriod})` : `Theory (1 Slot: P${period})`}</span> | Day: <strong>${day}</strong> | Period: <strong>${period}</strong></div>
      ${(initialType === 'P' && pracTeachers.length > 1) ? `
        <button type="button" class="btn btn-success btn-xs" onclick="assignAllPracticalCoTeachers('${courseCode}', '${day}', '${period}')" style="font-weight: 700; padding: 3px 8px;">
          <i class="fa-solid fa-users"></i> Assign All Co-Teachers (${pracTeachers.join(' + ')})
        </button>
      ` : ''}
    </div>

    <!-- Theory / Practical Toggle Option -->
    <div style="display:flex; align-items:center; justify-content:space-between; background:var(--background); padding:8px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border); margin-bottom:12px;">
      <span style="font-size:12px; font-weight:700; color:var(--text-muted);"><i class="fa-solid fa-shapes text-primary"></i> Allocation Type:</span>
      <div style="display:flex; gap:6px;">
        <button type="button" id="btn-manual-assign-type-theory" class="btn btn-xs btn-assign-type-theory ${initialType === 'T' ? 'active' : ''}" onclick="setManualAssignType('T')">
          <i class="fa-solid fa-book"></i> Theory (1 Slot: P${period})
        </button>
        <button type="button" id="btn-manual-assign-type-practical" class="btn btn-xs btn-assign-type-practical ${initialType === 'P' ? 'active' : ''}" onclick="setManualAssignType('P')" ${!nextPeriod ? 'disabled title="Last period of the day cannot extend to next slot"' : ''}>
          <i class="fa-solid fa-flask"></i> Practical (2 Slots: P${period} + P${nextPeriod || 'None'})
        </button>
      </div>
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
  const course = findCourseForDept(courseCode);
  const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCodeForRec] || {};
  const pracTeachers = (mData.practicalTeachers && mData.practicalTeachers.length > 0)
    ? mData.practicalTeachers
    : ((course && course.practicalTeachers && course.practicalTeachers.length > 0) ? course.practicalTeachers : []);
  if (pracTeachers.length === 0) return;

  const nextPeriod = getNextRightPeriod(period);
  const periodsToAssign = nextPeriod ? [period, nextPeriod] : [period];
  const deptName = state.currentUser.departmentName;

  for (const p of periodsToAssign) {
    for (const facCode of pracTeachers) {
      if (checkLocalClash(facCode, day, p, courseCode)) {
        showModalAlert('Booking Conflict', `Faculty '${facCode}' is already allocated elsewhere during ${day} Period ${p}.`, 'danger');
        return;
      }
      const res = await authFetch(`${API_BASE}/allocations/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          courseCode,
          weekday: day,
          period: p,
          facultyCodes: [facCode]
        })
      });
      const validation = await res.json();
      if (!validation.valid) {
        showModalAlert('Booking Conflict', `Faculty '${facCode}' is already allocated elsewhere during ${day} Period ${p}.`, 'danger');
        return;
      }
    }
  }

  periodsToAssign.forEach(p => {
    if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
    if (!state.allocations[courseCode][day]) state.allocations[courseCode][day] = {};
    state.allocations[courseCode][day][p] = Array.from(new Set([...pracTeachers]));
  });

  // Track explicit manual assignments as 'P'
  if (!state.manualSlots) state.manualSlots = {};
  const cleanB = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  periodsToAssign.forEach(p => {
    state.manualSlots[`${courseCode}_${day}_${p}`] = 'P';
    state.manualSlots[`${baseCodeForRec}_${day}_${p}`] = 'P';
    state.manualSlots[`${cleanB}_${day}_${p}`] = 'P';
  });

  // Auto-fill other practical recommended slots if toggle is ON
  const toggleAutofill = document.getElementById('toggle-autofill-recommended');
  const isAutofillOn = !!(toggleAutofill && toggleAutofill.checked);

  const recs = course ? (
    (course.recommendations && Object.keys(course.recommendations).length > 0)
      ? course.recommendations
      : (course.masterRecommendations || {})
  ) : {};

  const clickedSlotRec = (recs[day] && recs[day][period]) || '';
  const isClickedSlotRecommended = (clickedSlotRec === 'P');

  if (isAutofillOn && course && isClickedSlotRecommended) {
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    const globalLocks = (state.config && state.config.globalLockedPeriods) || [];

    weekdays.forEach(d => {
      const dayRecs = recs[d] || {};
      Object.keys(dayRecs).forEach(p => {
        if (dayRecs[p] === 'P') {
          if (d === day && periodsToAssign.includes(String(p))) return;

          const isLockedByAdmin = globalLocks.some(l => isPeriodLockedForCourse(l, course, d, p, state.commonBatches || []));
          if (isLockedByAdmin) return;

          pracTeachers.forEach(fc => {
            const unavailList = (state.teacherUnavailability && state.teacherUnavailability[fc]) || [];
            const isUnavail = unavailList.some(u => u.day.toUpperCase() === d.toUpperCase() && (u.period === 'all' || String(u.period) === String(p)));
            const crossReq = (state.crossDepartmentRequests || []).find(r => 
              r.status === 'APPROVED' && 
              (r.assignedFacultyCode || '').toUpperCase() === fc.toUpperCase() &&
              (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === d.toUpperCase() && String(s.period) === String(p))
            );
            const hasClash = checkLocalClash(fc, d, p, courseCode);

            if (!hasClash && !isUnavail && !crossReq) {
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
  const { courseCode, day, period, assignmentType } = activeSlotContext;
  const nextPeriod = getNextRightPeriod(period);
  const isPracticalMode = (assignmentType === 'P' && nextPeriod);
  
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
    
    // Check slot 1 (selected period)
    const isUnavail1 = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(period)));
    const crossReq1 = (state.crossDepartmentRequests || []).find(r => 
      r.status === 'APPROVED' && 
      (r.assignedFacultyCode || '').toUpperCase() === (f.code || '').toUpperCase() &&
      (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period))
    );
    const hasLocalDeptClash1 = checkLocalClash(f.code, day, period, courseCode);

    // Check slot 2 (next right period) if Practical mode is selected
    let isUnavail2 = false;
    let crossReq2 = null;
    let hasLocalDeptClash2 = false;
    if (isPracticalMode && !isAssigned) {
      isUnavail2 = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(nextPeriod)));
      crossReq2 = (state.crossDepartmentRequests || []).find(r => 
        r.status === 'APPROVED' && 
        (r.assignedFacultyCode || '').toUpperCase() === (f.code || '').toUpperCase() &&
        (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(nextPeriod))
      );
      hasLocalDeptClash2 = checkLocalClash(f.code, day, nextPeriod, courseCode);
    }

    const tr = document.createElement('tr');
    
    // Check which actual course holds this allocation (T or P)
    let assignedCourseCode = courseCode;
    if (isAssigned) {
      if (assignedDirect.includes(f.code)) assignedCourseCode = courseCode;
      else if (assignedT.includes(f.code)) assignedCourseCode = courseTCode;
      else if (assignedP.includes(f.code)) assignedCourseCode = coursePCode;
    }
    
    const crossReq = crossReq1 || crossReq2;
    const isUnavail = isUnavail1 || isUnavail2;
    const hasClash = hasLocalDeptClash1 || hasLocalDeptClash2;
    const conflictPeriod = (crossReq2 || isUnavail2 || hasLocalDeptClash2) ? nextPeriod : period;

    let actionBtn = '';
    if (isAssigned) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" onclick="unassignFacultyFromModal('${assignedCourseCode}', '${f.code}')"><i class="fa-solid fa-user-minus"></i> Remove</button>`;
    } else if (crossReq) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" disabled title="Faculty member is teaching cross-department course ${crossReq.courseCode} in ${crossReq.requestingDept} on Period ${conflictPeriod}"><i class="fa-solid fa-ban"></i> Cross-Dept Busy</button>`;
    } else if (isUnavail) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" disabled title="Faculty member marked Period ${conflictPeriod} as unavailable"><i class="fa-solid fa-ban"></i> Unavailable</button>`;
    } else if (hasClash) {
      actionBtn = `<button class="btn btn-outline btn-xs btn-danger" disabled title="Faculty member is already allocated to another course on Period ${conflictPeriod}"><i class="fa-solid fa-ban"></i> Busy</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-xs" onclick="assignFacultyFromModal('${courseCode}', '${f.code}')"><i class="fa-solid fa-user-plus"></i> Assign</button>`;
    }

    tr.innerHTML = `
      <td style="text-align: center;"><span class="fac-pill">${f.code}</span></td>
      <td>
        <strong>${f.name}</strong>
        ${crossReq ? `<span class="badge" style="background: #fef3c7; color: #b45309; font-size: 10px; margin-left: 6px;"><i class="fa-solid fa-people-arrows"></i> Cross-Dept (${crossReq.courseCode} P${conflictPeriod})</span>` : (isUnavail ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 10px; margin-left: 6px;"><i class="fa-solid fa-calendar-xmark"></i> Blackout Slot (P${conflictPeriod})</span>` : (hasClash ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 10px; margin-left: 6px;"><i class="fa-solid fa-triangle-exclamation"></i> Clash (Busy on ${day} P${conflictPeriod})</span>` : ''))}
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
  const { day, period, assignmentType, baseCode } = activeSlotContext;
  const nextPeriod = getNextRightPeriod(period);
  const isPrac = (assignmentType === 'P' && nextPeriod);
  const periodsToAssign = isPrac ? [period, nextPeriod] : [period];
  const deptName = state.currentUser.departmentName;

  // Resolve target course code for T vs P if course has split -T / -P codes
  const allCoursesList = (typeof state !== 'undefined' && Array.isArray(state.courses)) ? state.courses : [];
  const cleanBase = baseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumMatch = (courseCode || baseCode).match(/(_G|_C)(\d+)/);
  const effClass = classNumMatch ? parseInt(classNumMatch[2]) : null;
  const hasRealSplitT = !!allCoursesList.find(c => c.code === (cleanBase + '-T') || (c.code.startsWith(cleanBase + '_C') && c.code.endsWith('-T')));
  const hasRealSplitP = !!allCoursesList.find(c => c.code === (cleanBase + '-P') || (c.code.startsWith(cleanBase + '_C') && c.code.endsWith('-P')));
  const classSuffix = effClass ? `_C${effClass}` : '';

  let targetCourseCode = courseCode;
  let oppositeCode = null;
  if (isPrac && hasRealSplitP) {
    targetCourseCode = `${cleanBase}${classSuffix}-P`;
    oppositeCode = `${cleanBase}${classSuffix}-T`;
  } else if (!isPrac && hasRealSplitT) {
    targetCourseCode = `${cleanBase}${classSuffix}-T`;
    oppositeCode = `${cleanBase}${classSuffix}-P`;
  }

  // 1. Check local clash across periodsToAssign
  for (const p of periodsToAssign) {
    if (checkLocalClash(facultyCode, day, p, targetCourseCode)) {
      showModalAlert(
        'Hard Booking Clash!',
        `Double-booking violation!\n\nFaculty member '${facultyCode}' is already allocated to another course on ${day} Period ${p}.`,
        'danger'
      );
      return;
    }
  }

  // 2. Check Teacher Unavailability across periodsToAssign
  const unavailList = (state.teacherUnavailability && state.teacherUnavailability[facultyCode]) || [];
  for (const p of periodsToAssign) {
    const isUnavail = unavailList.some(u => u.day.toUpperCase() === day.toUpperCase() && (u.period === 'all' || String(u.period) === String(p)));
    if (isUnavail) {
      showModalAlert('Unavailable Slot', `Faculty member '${facultyCode}' marked ${day} Period ${p} as unavailable.`, 'danger');
      return;
    }
  }

  // 3. Check Cross-Department Requests across periodsToAssign
  for (const p of periodsToAssign) {
    const crossReq = (state.crossDepartmentRequests || []).find(r => 
      r.status === 'APPROVED' && 
      (r.assignedFacultyCode || '').toUpperCase() === facultyCode.toUpperCase() &&
      (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(p))
    );
    if (crossReq) {
      showModalAlert('Cross-Dept Busy', `Faculty '${facultyCode}' is teaching cross-department course ${crossReq.courseCode} in ${crossReq.requestingDept} on ${day} Period ${p}.`, 'danger');
      return;
    }
  }

  // 4. Validate with backend /api/allocations/validate for each period in periodsToAssign
  try {
    for (const p of periodsToAssign) {
      const res = await authFetch(`${API_BASE}/allocations/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          courseCode: targetCourseCode,
          weekday: day,
          period: p,
          facultyCodes: [facultyCode]
        })
      });
      const validation = await res.json();
      
      if (!validation.valid) {
        const conf = validation.conflicts[0];
        const clashingCourse = findCourseForDept(conf.clashingCourseCode);
        const clashingClassNum = (clashingCourse && (clashingCourse.class || clashingCourse.group)) || (conf.clashingCourseCode.match(/(_G|_C)(\d+)/) ? conf.clashingCourseCode.match(/(_G|_C)(\d+)/)[2] : null);
        const clashingGroupSuffix = clashingClassNum ? ` (Class C${clashingClassNum})` : '';
        showModalAlert(
          'Hard Booking Clash!', 
          `Double-booking violation!\n\nFaculty member '${conf.facultyName}' (${conf.facultyCode}) is already allocated to '${conf.clashingCourseName}' (${conf.clashingCourseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '')}${clashingGroupSuffix}) on ${day} Period ${p} in department ${conf.department}.`,
          'danger'
        );
        return;
      }
    }
    
    // Save locally for all assigned periods
    periodsToAssign.forEach(p => {
      if (!state.allocations[targetCourseCode]) state.allocations[targetCourseCode] = {};
      if (!state.allocations[targetCourseCode][day]) state.allocations[targetCourseCode][day] = {};
      if (!state.allocations[targetCourseCode][day][p]) state.allocations[targetCourseCode][day][p] = [];
      
      if (!state.allocations[targetCourseCode][day][p].includes(facultyCode)) {
        state.allocations[targetCourseCode][day][p].push(facultyCode);
      }
    });

    // Track explicit manual assignment with exact type ('P' or 'T')
    const manualType = isPrac ? 'P' : 'T';
    if (!state.manualSlots) state.manualSlots = {};
    periodsToAssign.forEach(p => {
      state.manualSlots[`${targetCourseCode}_${day}_${p}`] = manualType;
      state.manualSlots[`${courseCode}_${day}_${p}`] = manualType;
      state.manualSlots[`${baseCode}_${day}_${p}`] = manualType;
      state.manualSlots[`${cleanBase}_${day}_${p}`] = manualType;
      if (classSuffix) {
        state.manualSlots[`${cleanBase}${classSuffix}_${day}_${p}`] = manualType;
        state.manualSlots[`${cleanBase}${classSuffix}-P_${day}_${p}`] = manualType;
        state.manualSlots[`${cleanBase}${classSuffix}-T_${day}_${p}`] = manualType;
      }
    });

    // Clean up opposite code if teacher was previously in that slot under opposite variant
    if (oppositeCode && oppositeCode !== targetCourseCode) {
      periodsToAssign.forEach(p => {
        if (state.allocations[oppositeCode]?.[day]?.[p]) {
          state.allocations[oppositeCode][day][p] = state.allocations[oppositeCode][day][p].filter(c => c !== facultyCode);
        }
      });
    }

    const course = findCourseForDept(targetCourseCode) || findCourseForDept(baseCode);
    const baseCodeForRec = targetCourseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');

    // Check if auto-fill recommended toggle is ON
    const toggleAutofill = document.getElementById('toggle-autofill-recommended');
    const isAutofillOn = !!(toggleAutofill && toggleAutofill.checked);

    const recs = course ? (
      (course.recommendations && Object.keys(course.recommendations).length > 0)
        ? course.recommendations
        : (course.masterRecommendations || {})
    ) : {};
    
    const clickedSlotRec = (recs[day] && recs[day][period]) || '';
    const isClickedSlotRecommended = (clickedSlotRec === 'T' || clickedSlotRec === 'P');

    // Auto-fill ONLY runs if:
    // 1. Toggle is ON
    // 2. The course has recommendations
    // 3. The user clicked on an actual recommended slot ('T' or 'P'). Clicking an unrecommended slot will NOT auto-fill!
    if (isAutofillOn && course && isClickedSlotRecommended) {
      const targetType = clickedSlotRec;
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
      const globalLocks = (state.config && state.config.globalLockedPeriods) || [];

      // STRICT QUOTA ENFORCEMENT: Never assign more hours to this teacher than mapped!
      const mapping = localSubjectMappings[targetCourseCode] || localSubjectMappings[baseCodeForRec] || {};
      const teacherQuota = (targetType === 'P')
        ? (parseInt(mapping.practicalHours || course.practicalHours) || 2)
        : (parseInt((mapping.theoryTeacherHours && mapping.theoryTeacherHours[facultyCode]) ||
                    (mapping.teacherHours && mapping.teacherHours[facultyCode]) ||
                    (course.theoryTeacherHours && course.theoryTeacherHours[facultyCode]) ||
                    course.theoryHours || course.hours) || 4);

      // Count hours already assigned to this faculty member in this course
      let currentFacultyHours = 0;
      const cDays = state.allocations[targetCourseCode] || {};
      Object.values(cDays).forEach(pMap => {
        Object.values(pMap || {}).forEach(fList => {
          if (Array.isArray(fList) && fList.includes(facultyCode)) currentFacultyHours++;
        });
      });

      weekdays.forEach(d => {
        const dayRecs = recs[d] || {};
        Object.keys(dayRecs).forEach(p => {
          if (dayRecs[p] === targetType) {
            // Stop if teacher's quota for this course is reached
            if (currentFacultyHours >= teacherQuota) return;

            // Skip the current periods which were already assigned
            if (d === day && periodsToAssign.includes(String(p))) return;

            // Check admin lock
            const isLockedByAdmin = globalLocks.some(l => isPeriodLockedForCourse(l, course, d, p, state.commonBatches || []));
            if (isLockedByAdmin) return;

            // Check if teacher has an unavailability or clash in department
            const unavailList = (state.teacherUnavailability && state.teacherUnavailability[facultyCode]) || [];
            const isUnavail = unavailList.some(u => u.day.toUpperCase() === d.toUpperCase() && (u.period === 'all' || String(u.period) === String(p)));
            const crossReq = (state.crossDepartmentRequests || []).find(r => 
              r.status === 'APPROVED' && 
              (r.assignedFacultyCode || '').toUpperCase() === facultyCode.toUpperCase() &&
              (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === d.toUpperCase() && String(s.period) === String(p))
            );
            const hasClash = checkLocalClash(facultyCode, d, p, targetCourseCode);

            if (!hasClash && !isUnavail && !crossReq) {
              if (!state.allocations[targetCourseCode]) state.allocations[targetCourseCode] = {};
              if (!state.allocations[targetCourseCode][d]) state.allocations[targetCourseCode][d] = {};
              if (!state.allocations[targetCourseCode][d][p]) state.allocations[targetCourseCode][d][p] = [];

              if (!state.allocations[targetCourseCode][d][p].includes(facultyCode)) {
                state.allocations[targetCourseCode][d][p].push(facultyCode);
                currentFacultyHours++;
              }
            }
          }
        });
      });
    }

    // For practical slots: keep modal open so helpers can be assigned to the same period, with real-time update
    if (isPrac) {
      syncAllocationsToSubjectMapping(targetCourseCode);
      renderFacultySelectList();
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      triggerAutosave();
    } else {
      // Close faculty selector modal for single-teacher theory slots
      syncAllocationsToSubjectMapping(targetCourseCode);
      document.getElementById('modal-faculty-select').classList.add('hidden');
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      activeSlotContext = null;
      triggerAutosave();
    }
  } catch (err) {
    console.error("Assign faculty error:", err);
    showModalAlert('Error', 'Failed to communicate with server.', 'danger');
  }
};

window.unassignFacultyFromModal = function(courseCode, facultyCode) {
  if (!activeSlotContext) return;
  const { day, period, assignmentType } = activeSlotContext;
  const nextPeriod = getNextRightPeriod(period);
  const isPrac = (assignmentType === 'P' && nextPeriod);
  const periodsToRemove = isPrac ? [period, nextPeriod] : [period];
  const myDept = ((state.currentUser && state.currentUser.departmentName) || '').trim().toUpperCase();

  for (const p of periodsToRemove) {
    const isCross = (state.crossDepartmentRequests || []).some(r =>
      r.status === 'APPROVED' &&
      (r.assignedFacultyCode || '').toUpperCase() === (facultyCode || '').toUpperCase() &&
      (r.requestingDept || '').trim().toUpperCase() === myDept &&
      (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === (day || '').toUpperCase() && String(s.period) === String(p))
    );

    if (isCross) {
      showModalAlert(
        'Cross-Department Assignment',
        `Faculty member '${facultyCode}' is permanently assigned to this slot via Cross-Department Teaching.\n\nIt cannot be removed manually from the timetable. To remove this assignment, open Advanced Features > Cross-Dept Teaching > Outgoing Requests and click "Delete Request & Clear Allocation".`,
        'info'
      );
      return;
    }
  }
  
  const cleanBase = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumMatch = (courseCode || '').match(/(_G|_C)(\d+)/);
  const effClass = classNumMatch ? parseInt(classNumMatch[2]) : null;
  const classSuffix = effClass ? `_C${effClass}` : '';
  const keysToTry = [
    courseCode,
    `${courseCode}-T`,
    `${courseCode}-P`,
    courseCode.replace(/-(T|P)$/, ''),
    cleanBase,
    `${cleanBase}${classSuffix}`,
    `${cleanBase}${classSuffix}-T`,
    `${cleanBase}${classSuffix}-P`
  ];
  let changed = false;
  keysToTry.forEach(k => {
    periodsToRemove.forEach(p => {
      if (state.allocations[k] && state.allocations[k][day] && state.allocations[k][day][p]) {
        if (state.allocations[k][day][p].includes(facultyCode)) {
          state.allocations[k][day][p] = state.allocations[k][day][p].filter(code => code !== facultyCode);
          changed = true;
        }
      }
    });
  });

  if (changed) {
    if (state.manualSlots) {
      periodsToRemove.forEach(p => {
        const anyRemaining = keysToTry.some(k => (state.allocations[k]?.[day]?.[p]?.length || 0) > 0);
        if (!anyRemaining) {
          keysToTry.forEach(k => delete state.manualSlots[`${k}_${day}_${p}`]);
        }
      });
    }
    syncAllocationsToSubjectMapping(courseCode);
    renderFacultySelectList(); // refresh list in modal
    renderAllocationMatrix(); // refresh grid
    updateDeptLiveWorkloadTracker(); // refresh workload
    triggerAutosave();
  }
};

window.unassignFaculty = function(courseCode, day, period, facultyCode) {
  const myDept = ((state.currentUser && state.currentUser.departmentName) || '').trim().toUpperCase();

  const isCross = (state.crossDepartmentRequests || []).some(r =>
    r.status === 'APPROVED' &&
    (r.assignedFacultyCode || '').toUpperCase() === (facultyCode || '').toUpperCase() &&
    (r.requestingDept || '').trim().toUpperCase() === myDept &&
    (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === (day || '').toUpperCase() && String(s.period) === String(period))
  );

  if (isCross) {
    showModalAlert(
      'Cross-Department Assignment',
      `Faculty member '${facultyCode}' is permanently assigned to this slot via Cross-Department Teaching.\n\nIt cannot be removed manually from the timetable grid. To remove this assignment, open Advanced Features > Cross-Dept Teaching > Outgoing Requests and click "Delete Request & Clear Allocation".`,
      'info'
    );
    return;
  }

  const cleanBase = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNumMatch = (courseCode || '').match(/(_G|_C)(\d+)/);
  const effClass = classNumMatch ? parseInt(classNumMatch[2]) : null;
  const classSuffix = effClass ? `_C${effClass}` : '';
  const keysToTry = [
    courseCode,
    `${courseCode}-T`,
    `${courseCode}-P`,
    courseCode.replace(/-(T|P)$/, ''),
    cleanBase,
    `${cleanBase}${classSuffix}`,
    `${cleanBase}${classSuffix}-T`,
    `${cleanBase}${classSuffix}-P`
  ];
  let changed = false;
  keysToTry.forEach(k => {
    if (state.allocations[k] && state.allocations[k][day] && state.allocations[k][day][period]) {
      if (state.allocations[k][day][period].includes(facultyCode)) {
        state.allocations[k][day][period] = state.allocations[k][day][period].filter(code => code !== facultyCode);
        changed = true;
      }
    }
  });

  if (changed) {
    if (state.manualSlots) {
      const anyRemaining = keysToTry.some(k => (state.allocations[k]?.[day]?.[period]?.length || 0) > 0);
      if (!anyRemaining) {
        keysToTry.forEach(k => delete state.manualSlots[`${k}_${day}_${period}`]);
      }
    }
    syncAllocationsToSubjectMapping(courseCode);
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
    const course = findCourseForDept(courseCode);
    const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
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
              const teacherQuota = (type === 'P')
                ? (parseInt(mData.practicalHours || (course && course.practicalHours)) || 2)
                : (parseInt((mData.theoryTeacherHours && mData.theoryTeacherHours[fc]) ||
                            (mData.teacherHours && mData.teacherHours[fc]) ||
                            (course && course.theoryTeacherHours && course.theoryTeacherHours[fc]) ||
                            (course && (course.theoryHours || course.hours))) || 4);

              let currentFcHours = 0;
              const curDays = state.allocations[courseCode] || {};
              Object.values(curDays).forEach(pMap => {
                Object.values(pMap || {}).forEach(list => {
                  if (Array.isArray(list) && list.includes(fc)) currentFcHours++;
                });
              });

              if (currentFcHours >= teacherQuota) return;

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
  const normExclude = (excludeCourseCode || '').replace(/-(T|P)$/, '');
  for (const courseCode of Object.keys(state.allocations)) {
    if (courseCode === excludeCourseCode) continue;
    if (courseCode.replace(/-(T|P)$/, '') === normExclude) continue;
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
// Inline Editors (Department View: Courses & Faculty Aliases)
// -------------------------------------------------------------
const deptEditorFilters = {
  courseSearch: '',
  courseProgram: '',
  courseSemester: '',
  courseCategory: '',
  facultySearch: '',
  facultyProgram: '',
  facultySemester: '',
  facultyCategory: ''
};

function getFacultyAssignedCourses(facCode, deptName) {
  if (!facCode) return [];
  const normCode = facCode.trim().toUpperCase();
  const matchedCourses = new Set();
  const deptAlloc = state.allocations || {};

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    Object.values(dayObj || {}).forEach(periodObj => {
      Object.values(periodObj || {}).forEach(facVal => {
        let facCodes = [];
        if (Array.isArray(facVal)) {
          facCodes = facVal;
        } else if (typeof facVal === 'string') {
          facCodes = facVal.split(',').map(s => s.trim());
        }
        if (facCodes.some(fc => (fc || '').trim().toUpperCase() === normCode)) {
          const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
          const course = (state.courses || []).find(c => c.code === cCode) ||
                         (state.courses || []).find(c => c.code === baseCode);
          if (course) matchedCourses.add(course);
        }
      });
    });
  });

  (state.crossDepartmentRequests || []).forEach(r => {
    if (r.status === 'APPROVED' && (r.assignedFacultyCode || '').trim().toUpperCase() === normCode) {
      const baseCode = (r.courseCode || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      const course = (state.courses || []).find(c => c.code === r.courseCode) ||
                     (state.courses || []).find(c => c.code === baseCode);
      if (course) matchedCourses.add(course);
    }
  });

  return Array.from(matchedCourses);
}

function populateDeptEditorFilterDropdowns() {
  if (!state.currentUser || !state.currentUser.departmentName) return;
  const deptName = state.currentUser.departmentName;
  const deptCourses = (state.courses || []).filter(c => c.department === deptName);
  const getSemLabel = window.getSemesterLabel || function(s) { return state.config?.semesterLabels?.[s] || `Sem ${s}`; };

  // 1. Courses Dropdowns
  const semCourseSelect = document.getElementById('filter-dept-courses-sem');
  const catCourseSelect = document.getElementById('filter-dept-courses-cat');
  const progCourseSelect = document.getElementById('filter-dept-courses-prog');

  if (progCourseSelect) progCourseSelect.value = deptEditorFilters.courseProgram || '';

  if (semCourseSelect) {
    let availableCourses = deptCourses;
    if (deptEditorFilters.courseProgram) {
      availableCourses = availableCourses.filter(c => (c.programType || 'UG') === deptEditorFilters.courseProgram);
    }
    const sems = Array.from(new Set(availableCourses.map(c => c.semester))).filter(Boolean).sort((a,b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const prevSem = deptEditorFilters.courseSemester;

    semCourseSelect.innerHTML = `
      <option value="">All Semesters</option>
      <option value="odd">Odd Semesters (1, 3, 5)</option>
      <option value="even">Even Semesters (2, 4)</option>
    `;
    sems.forEach(s => {
      let label = getSemLabel(s, deptEditorFilters.courseProgram || 'UG');
      semCourseSelect.innerHTML += `<option value="${s}">${label}</option>`;
    });

    if (['', 'odd', 'even'].includes(prevSem) || sems.includes(prevSem)) {
      semCourseSelect.value = prevSem;
    } else {
      deptEditorFilters.courseSemester = '';
      semCourseSelect.value = '';
    }
  }

  if (catCourseSelect) {
    let availableCourses = deptCourses;
    if (deptEditorFilters.courseProgram) {
      availableCourses = availableCourses.filter(c => (c.programType || 'UG') === deptEditorFilters.courseProgram);
    }
    const cats = Array.from(new Set(availableCourses.map(c => c.category))).filter(Boolean).sort();
    const prevCat = deptEditorFilters.courseCategory;

    catCourseSelect.innerHTML = '<option value="">All Categories</option>';
    cats.forEach(c => {
      catCourseSelect.innerHTML += `<option value="${c}">${c}</option>`;
    });

    if (cats.includes(prevCat)) {
      catCourseSelect.value = prevCat;
    } else {
      deptEditorFilters.courseCategory = '';
      catCourseSelect.value = '';
    }
  }

  // 2. Faculty Dropdowns
  const semFacSelect = document.getElementById('filter-dept-faculty-sem');
  const catFacSelect = document.getElementById('filter-dept-faculty-cat');
  const progFacSelect = document.getElementById('filter-dept-faculty-prog');

  if (progFacSelect) progFacSelect.value = deptEditorFilters.facultyProgram || '';

  if (semFacSelect) {
    let availableCourses = deptCourses;
    if (deptEditorFilters.facultyProgram) {
      availableCourses = availableCourses.filter(c => (c.programType || 'UG') === deptEditorFilters.facultyProgram);
    }
    const sems = Array.from(new Set(availableCourses.map(c => c.semester))).filter(Boolean).sort((a,b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const prevSem = deptEditorFilters.facultySemester;

    semFacSelect.innerHTML = `
      <option value="">All Semesters</option>
      <option value="odd">Odd Semesters (1, 3, 5)</option>
      <option value="even">Even Semesters (2, 4)</option>
    `;
    sems.forEach(s => {
      let label = getSemLabel(s, deptEditorFilters.facultyProgram || 'UG');
      semFacSelect.innerHTML += `<option value="${s}">${label}</option>`;
    });

    if (['', 'odd', 'even'].includes(prevSem) || sems.includes(prevSem)) {
      semFacSelect.value = prevSem;
    } else {
      deptEditorFilters.facultySemester = '';
      semFacSelect.value = '';
    }
  }

  if (catFacSelect) {
    let availableCourses = deptCourses;
    if (deptEditorFilters.facultyProgram) {
      availableCourses = availableCourses.filter(c => (c.programType || 'UG') === deptEditorFilters.facultyProgram);
    }
    const cats = Array.from(new Set(availableCourses.map(c => c.category))).filter(Boolean).sort();
    const prevCat = deptEditorFilters.facultyCategory;

    catFacSelect.innerHTML = '<option value="">All Categories</option>';
    cats.forEach(c => {
      catFacSelect.innerHTML += `<option value="${c}">${c}</option>`;
    });

    if (cats.includes(prevCat)) {
      catFacSelect.value = prevCat;
    } else {
      deptEditorFilters.facultyCategory = '';
      catFacSelect.value = '';
    }
  }
}

let deptEditorFilterEventsBound = false;
function bindDeptEditorFilterEvents() {
  if (deptEditorFilterEventsBound) return;
  deptEditorFilterEventsBound = true;

  // Course Search
  const courseSearchInput = document.getElementById('filter-dept-courses-search');
  if (courseSearchInput) {
    courseSearchInput.addEventListener('input', (e) => {
      deptEditorFilters.courseSearch = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Course Program
  const courseProgSelect = document.getElementById('filter-dept-courses-prog');
  if (courseProgSelect) {
    courseProgSelect.addEventListener('change', (e) => {
      deptEditorFilters.courseProgram = e.target.value;
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
    });
  }

  // Course Semester
  const courseSemSelect = document.getElementById('filter-dept-courses-sem');
  if (courseSemSelect) {
    courseSemSelect.addEventListener('change', (e) => {
      deptEditorFilters.courseSemester = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Course Category
  const courseCatSelect = document.getElementById('filter-dept-courses-cat');
  if (courseCatSelect) {
    courseCatSelect.addEventListener('change', (e) => {
      deptEditorFilters.courseCategory = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Course Sync Grid Filters
  const btnSyncCourseFilters = document.getElementById('btn-sync-dept-courses-filters');
  if (btnSyncCourseFilters) {
    btnSyncCourseFilters.addEventListener('click', () => {
      deptEditorFilters.courseProgram = state.filters.program || '';
      deptEditorFilters.courseSemester = state.filters.semester || '';
      deptEditorFilters.courseCategory = state.filters.category || '';
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
      const origText = btnSyncCourseFilters.innerHTML;
      btnSyncCourseFilters.innerHTML = '<i class="fa-solid fa-check text-success"></i> Synced!';
      setTimeout(() => { btnSyncCourseFilters.innerHTML = origText; }, 1500);
    });
  }

  // Course Reset Filters
  const btnResetCourseFilters = document.getElementById('btn-reset-dept-courses-filters');
  if (btnResetCourseFilters) {
    btnResetCourseFilters.addEventListener('click', () => {
      deptEditorFilters.courseSearch = '';
      deptEditorFilters.courseProgram = '';
      deptEditorFilters.courseSemester = '';
      deptEditorFilters.courseCategory = '';
      if (courseSearchInput) courseSearchInput.value = '';
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
    });
  }

  // Faculty Search
  const facultySearchInput = document.getElementById('filter-dept-faculty-search');
  if (facultySearchInput) {
    facultySearchInput.addEventListener('input', (e) => {
      deptEditorFilters.facultySearch = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Faculty Program
  const facultyProgSelect = document.getElementById('filter-dept-faculty-prog');
  if (facultyProgSelect) {
    facultyProgSelect.addEventListener('change', (e) => {
      deptEditorFilters.facultyProgram = e.target.value;
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
    });
  }

  // Faculty Semester
  const facultySemSelect = document.getElementById('filter-dept-faculty-sem');
  if (facultySemSelect) {
    facultySemSelect.addEventListener('change', (e) => {
      deptEditorFilters.facultySemester = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Faculty Category
  const facultyCatSelect = document.getElementById('filter-dept-faculty-cat');
  if (facultyCatSelect) {
    facultyCatSelect.addEventListener('change', (e) => {
      deptEditorFilters.facultyCategory = e.target.value;
      renderDeptDataEditors();
    });
  }

  // Faculty Sync Grid Filters
  const btnSyncFacFilters = document.getElementById('btn-sync-dept-faculty-filters');
  if (btnSyncFacFilters) {
    btnSyncFacFilters.addEventListener('click', () => {
      deptEditorFilters.facultyProgram = state.filters.program || '';
      deptEditorFilters.facultySemester = state.filters.semester || '';
      deptEditorFilters.facultyCategory = state.filters.category || '';
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
      const origText = btnSyncFacFilters.innerHTML;
      btnSyncFacFilters.innerHTML = '<i class="fa-solid fa-check text-success"></i> Synced!';
      setTimeout(() => { btnSyncFacFilters.innerHTML = origText; }, 1500);
    });
  }

  // Faculty Reset Filters
  const btnResetFacFilters = document.getElementById('btn-reset-dept-faculty-filters');
  if (btnResetFacFilters) {
    btnResetFacFilters.addEventListener('click', () => {
      deptEditorFilters.facultySearch = '';
      deptEditorFilters.facultyProgram = '';
      deptEditorFilters.facultySemester = '';
      deptEditorFilters.facultyCategory = '';
      if (facultySearchInput) facultySearchInput.value = '';
      populateDeptEditorFilterDropdowns();
      renderDeptDataEditors();
    });
  }
}

function renderDeptDataEditors() {
  const deptName = state.currentUser.departmentName;
  const deptCourses = state.courses.filter(c => c.department === deptName);
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  const locked = isTimetableLocked();

  const totalCoursesCount = deptCourses.length;
  const totalFacultyCount = deptFaculty.length;

  document.getElementById('count-dept-courses').textContent = totalCoursesCount;
  document.getElementById('count-dept-faculty').textContent = totalFacultyCount;

  // Filter Courses
  let filteredCourses = deptCourses;

  if (deptEditorFilters.courseProgram) {
    filteredCourses = filteredCourses.filter(c => (c.programType || 'UG') === deptEditorFilters.courseProgram);
  }

  if (deptEditorFilters.courseSemester) {
    if (deptEditorFilters.courseSemester === 'odd') {
      filteredCourses = filteredCourses.filter(c => {
        const sNum = parseInt(c.semester, 10);
        return !isNaN(sNum) && sNum % 2 !== 0;
      });
    } else if (deptEditorFilters.courseSemester === 'even') {
      filteredCourses = filteredCourses.filter(c => {
        const sNum = parseInt(c.semester, 10);
        return !isNaN(sNum) && sNum % 2 === 0;
      });
    } else {
      filteredCourses = filteredCourses.filter(c => String(c.semester) === String(deptEditorFilters.courseSemester));
    }
  }

  if (deptEditorFilters.courseCategory) {
    filteredCourses = filteredCourses.filter(c => (c.category || '').toUpperCase() === deptEditorFilters.courseCategory.toUpperCase());
  }

  if (deptEditorFilters.courseSearch && deptEditorFilters.courseSearch.trim()) {
    const q = deptEditorFilters.courseSearch.trim().toLowerCase();
    filteredCourses = filteredCourses.filter(c => {
      const mappedBatches = getCourseClassBatches(c) || [];
      const cleanCode = (c.code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      const classNumMatch = (c.code || '').match(/(_G|_C)(\d+)/);
      const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || 0);
      const formattedCode = formatCourseCodeWithGroup(cleanCode, classNum, mappedBatches);

      return (
        (c.code && c.code.toLowerCase().includes(q)) ||
        (cleanCode && cleanCode.toLowerCase().includes(q)) ||
        (formattedCode && formattedCode.toLowerCase().includes(q)) ||
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.alias && c.alias.toLowerCase().includes(q)) ||
        (c.category && c.category.toLowerCase().includes(q)) ||
        mappedBatches.some(b => String(b).toLowerCase().includes(q))
      );
    });
  }

  const textCoursesCount = document.getElementById('text-dept-courses-count');
  if (textCoursesCount) {
    textCoursesCount.innerHTML = `<i class="fa-solid fa-book-open"></i> Showing ${filteredCourses.length} of ${totalCoursesCount} courses`;
  }

  // Render Courses Edit list
  const coursesTbody = document.querySelector('#table-dept-courses tbody');
  coursesTbody.innerHTML = '';

  if (filteredCourses.length === 0) {
    coursesTbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted p-4" style="background: #fafafa;">
          <i class="fa-solid fa-filter-circle-xmark text-secondary mb-2" style="font-size: 24px; opacity: 0.5;"></i>
          <p class="mb-0">No courses match the active filters or search query.</p>
        </td>
      </tr>
    `;
  } else {
    filteredCourses.forEach(c => {
      const mapped = getCourseClassBatches(c);
      const batchListHtml = mapped.length > 0 
        ? mapped.map(b => `<span class="badge badge-info" style="font-size: 11px; margin-right: 4px;">${b}</span>`).join('')
        : `<span class="text-muted text-sm">None</span>`;

      const tr = document.createElement('tr');
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
          </div>
        </td>
        <td>
          <button class="btn btn-outline btn-xs" onclick="saveDeptCourseRecord('${c.code}')" ${locked ? 'disabled' : ''}><i class="fa-solid fa-save"></i> Save</button>
        </td>
      `;
      const input = tr.querySelector(`input[id="calias-${c.code}"]`);
      if (input) {
        input.addEventListener('input', (e) => {
          c.alias = e.target.value;
        });
      }
      coursesTbody.appendChild(tr);
    });
  }

  // Filter Faculty
  let filteredFaculty = deptFaculty;
  const hasCourseCriteria = !!(deptEditorFilters.facultyProgram || deptEditorFilters.facultySemester || deptEditorFilters.facultyCategory);

  if (hasCourseCriteria) {
    filteredFaculty = filteredFaculty.filter(f => {
      const assignedCourses = getFacultyAssignedCourses(f.code, deptName);
      if (assignedCourses.length === 0) return false;

      return assignedCourses.some(c => {
        if (deptEditorFilters.facultyProgram) {
          if ((c.programType || 'UG') !== deptEditorFilters.facultyProgram) return false;
        }
        if (deptEditorFilters.facultySemester) {
          if (deptEditorFilters.facultySemester === 'odd') {
            const sNum = parseInt(c.semester, 10);
            if (isNaN(sNum) || sNum % 2 === 0) return false;
          } else if (deptEditorFilters.facultySemester === 'even') {
            const sNum = parseInt(c.semester, 10);
            if (isNaN(sNum) || sNum % 2 !== 0) return false;
          } else {
            if (String(c.semester) !== String(deptEditorFilters.facultySemester)) return false;
          }
        }
        if (deptEditorFilters.facultyCategory) {
          if ((c.category || '').toUpperCase() !== deptEditorFilters.facultyCategory.toUpperCase()) return false;
        }
        return true;
      });
    });
  }

  if (deptEditorFilters.facultySearch && deptEditorFilters.facultySearch.trim()) {
    const q = deptEditorFilters.facultySearch.trim().toLowerCase();
    filteredFaculty = filteredFaculty.filter(f => {
      const assignedCourses = getFacultyAssignedCourses(f.code, deptName);
      return (
        (f.staffId && String(f.staffId).toLowerCase().includes(q)) ||
        (f.name && f.name.toLowerCase().includes(q)) ||
        (f.code && f.code.toLowerCase().includes(q)) ||
        (f.designation && f.designation.toLowerCase().includes(q)) ||
        assignedCourses.some(c => 
          (c.code && c.code.toLowerCase().includes(q)) || 
          (c.name && c.name.toLowerCase().includes(q)) || 
          (c.alias && c.alias.toLowerCase().includes(q))
        )
      );
    });
  }

  const textFacultyCount = document.getElementById('text-dept-faculty-count');
  if (textFacultyCount) {
    textFacultyCount.innerHTML = `<i class="fa-solid fa-users"></i> Showing ${filteredFaculty.length} of ${totalFacultyCount} faculty`;
  }

  // Render Faculty Edit list
  const facultyTbody = document.querySelector('#table-dept-faculty tbody');
  facultyTbody.innerHTML = '';

  if (filteredFaculty.length === 0) {
    facultyTbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-muted p-4" style="background: #fafafa;">
          <i class="fa-solid fa-filter-circle-xmark text-secondary mb-2" style="font-size: 24px; opacity: 0.5;"></i>
          <p class="mb-0">No faculty match the active filters or search query.</p>
        </td>
      </tr>
    `;
  } else {
    deptFaculty.forEach(f => {
      if (!filteredFaculty.includes(f)) return;

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
      const input = tr.querySelector(`input[id="fcode-${f.staffId}"]`);
      if (input) {
        input.addEventListener('input', (e) => {
          f.code = e.target.value;
        });
      }
      facultyTbody.appendChild(tr);
    });
  }

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
  const el = document.getElementById(`calias-${code}`);
  const alias = el ? el.value.trim() : '';
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
  const el = document.getElementById(`fcode-${staffId}`);
  const code = el ? el.value.trim() : '';
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
    buildPrintTimetableHtml(document.getElementById('print-mode-select')?.value || 'medium');
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


function syncPrintViewsIfActive() {
  // 1. Department timetable print modal
  const printModal = document.getElementById('modal-print-preview');
  if (printModal && !printModal.classList.contains('hidden')) {
    const mode = document.getElementById('print-mode-select')?.value || 'medium';
    buildPrintTimetableHtml(mode);
  }

  // 2. Teacher timetable print modal
  const teacherModal = document.getElementById('modal-teacher-timetable');
  if (teacherModal && !teacherModal.classList.contains('hidden')) {
    const facCode = document.getElementById('select-teacher-timetable-faculty')?.value || 'ALL';
    const mode = document.getElementById('select-teacher-timetable-mode')?.value || 'medium';
    const container = document.getElementById('teacher-print-area');
    if (container) renderTeacherTimetables(container, facCode, mode);
  }
}

async function openTimetablePrintPreview(deptName) {
  activePrintDept = deptName || (state.currentUser ? state.currentUser.departmentName : '') || '';
  const printDeptElem = document.getElementById('print-dept-name');
  if (printDeptElem) printDeptElem.textContent = `DEPARTMENT OF ${activePrintDept}`;
  const printSemElem = document.getElementById('print-active-sem');
  if (printSemElem) printSemElem.textContent = `${(state.config && state.config.semesterType) || 'ODD'} SEMESTER`;
  const printYearElem = document.getElementById('print-active-year');
  if (printYearElem) printYearElem.textContent = (state.config && state.config.academicYear) || '';
  
  const modeSelect = document.getElementById('print-mode-select');
  const mode = modeSelect ? modeSelect.value : 'medium';

  // Always fetch latest allocations and cross-department requests for fresh display
  try {
    const [allocRes, crossDeptRes] = await Promise.all([
      authFetch(`${API_BASE}/allocations?department=${encodeURIComponent(activePrintDept)}`),
      authFetch(`${API_BASE}/cross-dept-requests`)
    ]);
    if (allocRes && allocRes.ok) {
      state.allocations = await allocRes.json();
    }
    if (crossDeptRes && crossDeptRes.ok) {
      const cdrData = await crossDeptRes.json();
      state.crossDepartmentRequests = cdrData.requests || [];
    }
  } catch (err) {
    console.error('Error fetching fresh preview data:', err);
  }

  buildPrintTimetableHtml(mode);
  
  const modal = document.getElementById('modal-print-preview');
  if (modal) modal.classList.remove('hidden');
}

function buildPrintTimetableHtml(displayMode) {
  const periods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
  const table = document.getElementById('print-grid-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  thead.innerHTML = `
    <tr>
      <th style="width: 80px;">Day</th>
      <th style="width: 100px; text-align: left;">Class/Semester</th>
      ${periods.map(p => `<th>${String(p).toUpperCase() === 'LB' ? 'Lunch Break' : p}</th>`).join('')}
    </tr>
  `;

  const deptUpper = (activePrintDept || (state.currentUser ? state.currentUser.departmentName : '') || '').trim().toUpperCase();
  const allocs = state.allocations || {};

  const approvedCrossReqs = (state.crossDepartmentRequests || []).filter(r => r.status === 'APPROVED' && r.assignedFacultyCode);

  const seenCanonical = new Set();
  const deptCourses = [];

  // 1. Department courses & courses allocated in this department
  (state.courses || []).forEach(c => {
    const cDept = (c.department || '').trim().toUpperCase();
    const cBase = (c.code || '').replace(/-(T|P)$/, '');
    const isDeptCourse = (cDept === deptUpper);
    const hasAlloc = Boolean(allocs[c.code] || allocs[cBase] || allocs[`${cBase}-T`] || allocs[`${cBase}-P`]);

    const hasCrossReq = approvedCrossReqs.some(r => 
      (r.requestingDept || '').trim().toUpperCase() === deptUpper &&
      (r.courseCode === c.code || r.courseCode === cBase || r.courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === cBase.replace(/(_G|_C)\d+$/, ''))
    );

    if (isDeptCourse || hasAlloc || hasCrossReq) {
      const canonKey = c.code.replace(/-(T|P)$/, '');
      if (!seenCanonical.has(canonKey)) {
        seenCanonical.add(canonKey);
        deptCourses.push(c);
      }
    }
  });

  // 2. Cross-department offerings taught by this department's teachers to other departments
  approvedCrossReqs.forEach(r => {
    if ((r.offeringDept || '').trim().toUpperCase() === deptUpper) {
      const canonKey = `CROSS_${r.courseCode}_${r.id}`;
      if (!seenCanonical.has(canonKey)) {
        seenCanonical.add(canonKey);
        const reqCourse = (state.courses || []).find(c => c.code === r.courseCode || c.code.replace(/-(T|P)$/, '') === r.courseCode) || {};
        deptCourses.push({
          code: r.courseCode,
          name: r.courseName || reqCourse.name || r.courseCode,
          alias: reqCourse.alias || r.courseCode,
          semester: r.semester || reqCourse.semester || '1',
          category: 'Cross-Dept',
          courseType: r.courseType || reqCourse.courseType || 'T',
          department: deptUpper,
          isCrossDeptOffering: true,
          crossDeptReq: r
        });
      }
    }
  });

  renderPrintGridRows(deptCourses, allocs, periods, displayMode, tbody);
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
  if (course.isCrossDeptOffering || course.category === 'Cross-Dept') {
    return 'Cross-Dept Teaching';
  }
  const romanMap = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };
  const semNum = parseInt(course.semester, 10);
  const semLabel = (!isNaN(semNum) && romanMap[semNum]) ? `${romanMap[semNum]} Sem` : (course.semester ? `Sem ${course.semester}` : '');
  const catStr = formatCategory(course.category);
  
  const isPg = (course.code && course.code.toUpperCase().includes('MSC')) || 
               (course.pathway && course.pathway.toUpperCase().includes('MSC')) || 
               (course.pathway && course.pathway.toUpperCase().includes('POST GRADUATE')) ||
               course.programType === 'PG';
  const isInt = course.programType === 'INT';
  const progLabel = isPg ? 'PG' : (isInt ? 'INT' : '');
  return [semLabel, progLabel, catStr].filter(Boolean).join(' ');
}

// Probes all possible allocation keys (exact, -T, -P, baseCode, class variants _C1-T, _C1-P)
function getCourseSlotAllocations(course, day, period, allocations) {
  if (!allocations || !course) return { codes: [], type: (course && course.courseType) || 'T' };
  
  const cCode = course.code || '';
  const cleanCode = cCode.replace(/-(T|P)$/, '');
  const baseCode = cleanCode.replace(/(_C|_G)\d+$/, '');
  const classMatch = cCode.match(/(_C|_G)(\d+)/);
  const classNum = course.classNum || (classMatch ? classMatch[2] : ((course.class && course.class > 0) ? course.class : null));

  const foundCodes = [];
  let detectedType = course.courseType || (cCode.endsWith('-P') ? 'P' : 'T');

  // Handle virtual offering row for cross-dept request
  if (course.isCrossDeptOffering && course.crossDeptReq) {
    const req = course.crossDeptReq;
    const slot = (req.pinnedSlots || []).find(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period));
    if (slot && req.assignedFacultyCode) {
      foundCodes.push(req.assignedFacultyCode);
      detectedType = slot.type || req.courseType || 'T';
      return { codes: foundCodes, type: detectedType };
    }
  }

  const keysToCheck = [];
  if (classNum) {
    keysToCheck.push({ key: `${baseCode}_C${classNum}-T`, type: 'T' });
    keysToCheck.push({ key: `${baseCode}_C${classNum}-P`, type: 'P' });
    keysToCheck.push({ key: `${baseCode}_C${classNum}`, type: detectedType });
    keysToCheck.push({ key: `${baseCode}_G${classNum}-T`, type: 'T' });
    keysToCheck.push({ key: `${baseCode}_G${classNum}-P`, type: 'P' });
    keysToCheck.push({ key: `${baseCode}_G${classNum}`, type: detectedType });
  } else {
    keysToCheck.push({ key: cCode, type: cCode.endsWith('-P') ? 'P' : (cCode.endsWith('-T') ? 'T' : detectedType) });
    keysToCheck.push({ key: `${cCode}-T`, type: 'T' });
    keysToCheck.push({ key: `${cCode}-P`, type: 'P' });
    keysToCheck.push({ key: `${baseCode}-T`, type: 'T' });
    keysToCheck.push({ key: `${baseCode}-P`, type: 'P' });
    keysToCheck.push({ key: baseCode, type: detectedType });
  }

  const seenKeys = new Set();
  keysToCheck.forEach(({ key, type }) => {
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);

    if (allocations[key] && allocations[key][day] && allocations[key][day][period]) {
      const list = allocations[key][day][period];
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(fc => {
          const cleanFc = (fc || '').trim();
          if (cleanFc && !foundCodes.includes(cleanFc)) {
            foundCodes.push(cleanFc);
          }
        });
      }
    }
  });

  // Also check state.crossDepartmentRequests for approved requests!
  const deptUpper = (activePrintDept || (state.currentUser ? state.currentUser.departmentName : '') || '').trim().toUpperCase();
  const approvedCross = (state.crossDepartmentRequests || []).find(r => 
    r.status === 'APPROVED' &&
    r.assignedFacultyCode &&
    (
      ((r.requestingDept || '').trim().toUpperCase() === deptUpper &&
        (
          r.courseCode === cCode ||
          r.courseCode === cleanCode ||
          r.courseCode === baseCode ||
          (classNum && (r.courseCode === `${baseCode}_C${classNum}` || r.courseCode === `${baseCode}_G${classNum}`)) ||
          r.courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === baseCode
        )
      ) ||
      (course.isCrossDeptOffering && (r.offeringDept || '').trim().toUpperCase() === deptUpper && r.id === (course.crossDeptReq && course.crossDeptReq.id))
    ) &&
    (r.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period))
  );

  if (approvedCross && approvedCross.assignedFacultyCode) {
    const cleanFc = approvedCross.assignedFacultyCode.trim();
    if (cleanFc && !foundCodes.includes(cleanFc)) {
      foundCodes.push(cleanFc);
    }
    const crossSlot = (approvedCross.pinnedSlots || []).find(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(period));
    if (crossSlot && crossSlot.type) {
      detectedType = crossSlot.type;
    } else if (approvedCross.courseType) {
      detectedType = approvedCross.courseType;
    }
  }

  if (foundCodes.length > 0) {
    const dayAllocations = {};
    const periodsList = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
    periodsList.forEach(p => {
      keysToCheck.forEach(({ key }) => {
        if (allocations[key] && allocations[key][day] && allocations[key][day][p]) {
          const l = allocations[key][day][p];
          if (Array.isArray(l) && l.length > 0) {
            dayAllocations[p] = Array.from(new Set([...(dayAllocations[p] || []), ...l]));
          }
        }
      });
      if (approvedCross && (approvedCross.pinnedSlots || []).some(s => (s.day || '').toUpperCase() === day.toUpperCase() && String(s.period) === String(p))) {
        dayAllocations[p] = Array.from(new Set([...(dayAllocations[p] || []), approvedCross.assignedFacultyCode]));
      }
    });
    detectedType = determineSlotType(course, cCode, day, period, foundCodes, dayAllocations);
  }

  return { codes: foundCodes, type: detectedType };
}

function renderPrintGridRows(courses, allocations, periods, displayMode, tbody) {
  tbody.innerHTML = '';
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const weekdayShort = { "MONDAY": "MON", "TUESDAY": "TUES", "WEDNESDAY": "WED", "THURSDAY": "THUR", "FRIDAY": "FRI" };

  // Expand courses that have classes > 1 into virtual course objects!
  const expandedCourses = [];
  courses.forEach(c => {
    const isAlreadyClassVariant = /(_C|_G)\d+/.test(c.code);
    if (!isAlreadyClassVariant && c.classes && c.classes > 1) {
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
        const slotDataMap = {};

        periods.forEach(p => {
          if (String(p).toUpperCase() === 'LB') return;
          const { codes: assigned, type: detectedType } = getCourseSlotAllocations(course, day, p, allocations);
          if (assigned.length > 0) {
            coursePeriods.push(p);
            const isPractical = detectedType === 'P';
            const printClass = detectedType === 'M' ? 'print-recommend-m' : (isPractical ? 'print-recommend-p' : 'print-recommend-t');
            const tooltip = assigned.map(code => {
              const facObj = (state.faculty || []).find(f => f.code === code);
              return facObj ? facObj.name : code;
            }).join(' / ');

            slotDataMap[p] = {
              html: formatAllocationCell(course, day, p, allocations, displayMode, detectedType),
              classes: printClass,
              tooltip: tooltip
            };
          }
        });

        if (coursePeriods.length === 0) return;

        let placed = false;
        for (let r = 0; r < subRows.length; r++) {
          const hasClash = coursePeriods.some(p => !!subRows[r][p]);
          if (!hasClash) {
            coursePeriods.forEach(p => {
              subRows[r][p] = slotDataMap[p];
            });
            placed = true;
            break;
          }
        }

        if (!placed) {
          const newRow = {};
          coursePeriods.forEach(p => {
            newRow[p] = slotDataMap[p];
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
          tdDay.textContent = weekdayShort[day] || day;
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
          if (String(p).toUpperCase() === 'LB') {
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

function formatAllocationCell(course, day, period, allocations, mode, detectedType = null) {
  const { codes: assignedCodes, type: allocType } = getCourseSlotAllocations(course, day, period, allocations);
  if (assignedCodes.length === 0) return '';

  const isOffering = Boolean(course.isCrossDeptOffering && course.crossDeptReq);
  const reqDept = isOffering ? (course.crossDeptReq.requestingDept || '') : '';
  const deptSuffix = reqDept ? ` (${reqDept})` : '';

  const alias = isOffering
    ? `${course.alias || course.code}${deptSuffix}`
    : (course.alias || course.name || course.code).replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const classNum = course.classNum || (course.code.match(/(_G|_C)(\d+)/) ? course.code.match(/(_G|_C)(\d+)/)[2] : ((course.class && course.class > 0) ? course.class : ((course.group && course.group > 0) ? course.group : null)));
  const groupSuffix = classNum ? ` (C${classNum})` : '';
  const isPractical = (detectedType || allocType) === 'P';

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
      const facObj = (state.faculty || []).find(f => f.code === code);
      return facObj ? facObj.name : code;
    }).join(' / ');
    const cleanName = isOffering
      ? `${course.name || course.code}${deptSuffix}`
      : (course.name || course.code).replace(/-(T|P)$/, '').replace(/\s+(T|P)$/, '');
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
  const targetDept = (deptName || (state.currentUser ? state.currentUser.departmentName : '') || '').trim().toUpperCase();
  const targetDeptNorm = targetDept.replace(/^DEPARTMENT\s+OF\s+/i, '').trim();
  const deptFaculty = (state.faculty || []).filter(f => {
    const fDeptNorm = (f.department || '').trim().toUpperCase().replace(/^DEPARTMENT\s+OF\s+/i, '').trim();
    return fDeptNorm === targetDeptNorm;
  });
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

  // Also initialize any faculty allocated in this department's timetable
  Object.values(deptAlloc).forEach(dayObj => {
    Object.values(dayObj || {}).forEach(periodObj => {
      Object.values(periodObj || {}).forEach(facList => {
        if (Array.isArray(facList)) {
          facList.forEach(facCode => {
            const fcNorm = (facCode || '').trim();
            if (fcNorm && !schedules[fcNorm]) {
              const facObj = (state.faculty || []).find(f => (f.code || '').trim().toUpperCase() === fcNorm.toUpperCase()) || {
                code: fcNorm,
                name: fcNorm,
                department: deptName,
                designation: 'Faculty Member'
              };
              schedules[fcNorm] = {
                info: facObj,
                totalHours: 0,
                theoryHours: 0,
                practicalHours: 0,
                slots: {}
              };
              weekdays.forEach(d => {
                schedules[fcNorm].slots[d] = {};
              });
            }
          });
        }
      });
    });
  });

  Object.entries(deptAlloc).forEach(([cCode, dayObj]) => {
    const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
    const course = (state.courses || []).find(c => c.code === cCode) || 
                   (state.courses || []).find(c => c.code === baseCode) || 
                   { code: cCode, name: cCode, alias: cCode, semester: '-', category: '-', courseType: 'T' };

    const classMatch = cCode.match(/(_C|_G)(\d+)/);
    const classSuffix = classMatch ? ` (C${classMatch[2]})` : '';
    const cleanAlias = (course.alias || course.name || cCode).replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
    const dispAlias = cleanAlias + classSuffix;

    Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (Array.isArray(facList) && facList.length > 0) {
          const slotType = determineSlotType(course, cCode, dayUpper, period, facList, periodObj);
          const isPrac = (slotType === 'P');

          facList.forEach(facCode => {
            const fc = (facCode || '').trim();
            const schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase()) || fc;
            if (schedules[schedKey]) {
              if (!schedules[schedKey].slots[dayUpper]) {
                schedules[schedKey].slots[dayUpper] = {};
              }
              if (!schedules[schedKey].slots[dayUpper][period]) {
                schedules[schedKey].slots[dayUpper][period] = [];
              }
              const already = schedules[schedKey].slots[dayUpper][period].some(x => x.courseCode === cCode);
              if (!already) {
                const coTeachers = facList.filter(f => f.trim().toUpperCase() !== fc.toUpperCase());
                schedules[schedKey].slots[dayUpper][period].push({
                  courseCode: cCode,
                  courseName: course.name || cCode,
                  courseAlias: dispAlias,
                  semester: course.semester,
                  category: course.category,
                  roomNo: course.roomNo || '',
                  section: classSuffix ? classSuffix.trim() : '',
                  coTeachers: coTeachers,
                  type: isPrac ? 'P' : 'T'
                });
                schedules[schedKey].totalHours++;
                if (isPrac) {
                  schedules[schedKey].practicalHours++;
                } else {
                  schedules[schedKey].theoryHours++;
                }
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
        const fc = (tCode || '').trim();
        const schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase()) || fc;
        if (schedules[schedKey]) {
          if (!schedules[schedKey].slots[dayUpper]) {
            schedules[schedKey].slots[dayUpper] = {};
          }
          if (!schedules[schedKey].slots[dayUpper][period]) {
            schedules[schedKey].slots[dayUpper][period] = [];
          }
          const already = schedules[schedKey].slots[dayUpper][period].some(x => x.courseCode === (b.courseCode || b.subjectCode) && x.batchName === b.batchName);
          if (!already) {
            schedules[schedKey].slots[dayUpper][period].push({
              courseCode: b.courseCode || b.subjectCode,
              courseName: `${b.batchName}: ${b.courseName || b.courseCode || b.subjectCode}`,
              courseAlias: `${b.batchName} (${b.subjectCode})`,
              semester: b.semester,
              category: b.subjectCode || 'MDC',
              type: 'T',
              batchName: b.batchName
            });
            schedules[schedKey].totalHours++;
            schedules[schedKey].theoryHours++;
          }
        }
      });
    });
  });

  // Include Approved Cross-Department Assignments into teachers' weekly schedules
  const crossDeptReqs = (state.crossDepartmentRequests || []).filter(r => r.status === 'APPROVED' && r.assignedFacultyCode);
  crossDeptReqs.forEach(r => {
    const fc = (r.assignedFacultyCode || '').trim();
    if (!fc) return;

    let schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase());
    if (!schedKey) {
      const facObj = (state.faculty || []).find(f => (f.code || '').trim().toUpperCase() === fc.toUpperCase());
      const fDeptNorm = (facObj && facObj.department ? facObj.department : '').trim().toUpperCase().replace(/^DEPARTMENT\s+OF\s+/i, '').trim();
      if (facObj && (!targetDeptNorm || fDeptNorm === targetDeptNorm)) {
        schedules[facObj.code] = {
          info: facObj,
          totalHours: 0,
          theoryHours: 0,
          practicalHours: 0,
          slots: {}
        };
        weekdays.forEach(d => { schedules[facObj.code].slots[d] = {}; });
        schedKey = facObj.code;
      }
    }

    if (schedules[schedKey]) {
      const courseObj = (state.courses || []).find(c => c.code === r.courseCode) || {
        code: r.courseCode,
        name: r.courseName || r.courseCode,
        alias: r.courseCode,
        semester: r.semester || '-',
        category: 'CROSS-DEPT'
      };

      const cleanAlias = (courseObj.alias || r.courseName || r.courseCode).replace(/-(T|P)$/, '');
      const reqDeptDisplay = r.requestingDept ? r.requestingDept.replace(/^DEPARTMENT\s+OF\s+/i, '').trim() : 'Cross-Dept';

      (r.pinnedSlots || []).forEach(slot => {
        const dayUpper = (slot.day || '').toUpperCase();
        const period = String(slot.period || '').trim();
        if (!dayUpper || !period) return;

        const isPrac = (slot.type === 'P' || (!slot.type && r.courseType === 'P'));

        if (!schedules[schedKey].slots[dayUpper]) {
          schedules[schedKey].slots[dayUpper] = {};
        }
        if (!schedules[schedKey].slots[dayUpper][period]) {
          schedules[schedKey].slots[dayUpper][period] = [];
        }

        const already = schedules[schedKey].slots[dayUpper][period].some(x => x.courseCode === r.courseCode && x.isCrossDept);
        if (!already) {
          schedules[schedKey].slots[dayUpper][period].push({
            courseCode: r.courseCode,
            courseName: `${r.courseName || courseObj.name || r.courseCode} (${reqDeptDisplay})`,
            courseAlias: `${cleanAlias} [${reqDeptDisplay}]`,
            semester: r.semester || courseObj.semester,
            category: `Cross-Dept (${reqDeptDisplay})`,
            roomNo: courseObj.roomNo || '',
            section: '',
            coTeachers: [],
            type: isPrac ? 'P' : 'T',
            isCrossDept: true,
            requestingDept: reqDeptDisplay
          });
          schedules[schedKey].totalHours++;
          if (isPrac) {
            schedules[schedKey].practicalHours++;
          } else {
            schedules[schedKey].theoryHours++;
          }
        }
      });
    }
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
          const coTeacherHtml = (item.coTeachers && item.coTeachers.length > 0)
            ? `<div class="teacher-slot-coteacher" style="font-size: 10px; color: #166534; font-weight: 700; margin-top: 2px;"><i class="fa-solid fa-users" style="font-size: 9px;"></i> with ${item.coTeachers.join(', ')}</div>`
            : '';
          const roomHtml = item.roomNo
            ? `<span class="teacher-slot-room" style="font-size: 10px; opacity: 0.85; font-weight: 600;">[Rm: ${item.roomNo}]</span>`
            : '';

          return `
            <div class="teacher-slot-inner">
              <span class="teacher-slot-course" title="${item.courseName} (${item.courseCode})">${dispText}</span>
              <div style="display: flex; gap: 4px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 2px;">
                ${semLabel ? `<span class="teacher-slot-sem-pill">${semLabel}</span>` : ''}
                ${roomHtml}
                <span class="teacher-slot-type-badge">${typeLabel}</span>
              </div>
              ${coTeacherHtml}
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
  const periods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];

  let facultyList = [];
  if (targetFacultyCode === 'ALL') {
    facultyList = Object.values(schedules);
  } else {
    const targetKey = Object.keys(schedules).find(k => k.toUpperCase() === String(targetFacultyCode).toUpperCase()) || targetFacultyCode;
    facultyList = [schedules[targetKey]].filter(Boolean);
  }

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
  const deptNorm = (deptName || '').replace(/^Department\s+of\s+/i, '').trim().toUpperCase();
  const deptFaculty = (state.faculty || []).filter(f => (f.department || '').replace(/^Department\s+of\s+/i, '').trim().toUpperCase() === deptNorm);

  const modalSelect = document.getElementById('select-teacher-timetable-faculty');
  const tabSelect = document.getElementById('tab-select-teacher-faculty');

  const curTabVal = tabSelect ? tabSelect.value : 'ALL';
  const curModalVal = modalSelect ? modalSelect.value : 'ALL';

  const optionsHtml = `
    <option value="ALL">All Teachers (${deptFaculty.length} Faculty Members)</option>
    ${deptFaculty.map(f => `<option value="${f.code}">${f.name} (${f.code})</option>`).join('')}
  `;

  if (modalSelect) {
    modalSelect.innerHTML = optionsHtml;
    modalSelect.value = curModalVal;
  }
  if (tabSelect) {
    tabSelect.innerHTML = optionsHtml;
    tabSelect.value = curTabVal;
  }
}

async function openTeacherTimetableModal(selectedFacultyCode = 'ALL') {
  try {
    const res = await authFetch(`${API_BASE}/cross-dept-requests`);
    if (res.ok) {
      const data = await res.json();
      state.crossDepartmentRequests = data.requests || [];
    }
  } catch (e) {}

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

async function renderTeacherTimetablesTab() {
  try {
    const res = await authFetch(`${API_BASE}/cross-dept-requests`);
    if (res.ok) {
      const data = await res.json();
      state.crossDepartmentRequests = data.requests || [];
    }
  } catch (e) {}

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
      const facCode = modalSelectFac ? modalSelectFac.value : 'ALL';
      const mode = modalSelectMode ? modalSelectMode.value : 'medium';
      if (printArea) renderTeacherTimetables(printArea, facCode, mode);
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

  const btnSwitchDept = document.getElementById('btn-switch-to-dept-timetable');
  if (btnSwitchDept) {
    btnSwitchDept.addEventListener('click', () => {
      const teacherModal = document.getElementById('modal-teacher-timetable');
      if (teacherModal) teacherModal.classList.add('hidden');
      openTimetablePrintPreview();
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
  setupCollapsibleCard(
    'header-subject-mapping-workload',
    'body-subject-mapping-workload',
    'btn-toggle-subject-mapping-workload',
    'subject_mapping_workload_collapsed',
    false
  );

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

  const coursesAssignFilter = document.getElementById('auto-gen-courses-assignment-filter');
  if (coursesAssignFilter) {
    coursesAssignFilter.addEventListener('change', () => {
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

  // Cross-Department Teaching Controls
  bindCrossDeptTeachingEvents();

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
  } else if (paneId === 'adv-pane-auto-generate') {
    initAutoGeneratorPane();
  } else if (paneId === 'adv-pane-curriculum-slots') {
    renderCurriculumSlotAllocator();
  } else if (paneId === 'adv-pane-cross-dept') {
    renderCrossDeptTeachingTab();
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

let isSyncingAllocationsToSubjectMapping = false;

function syncAllocationsToSubjectMapping(targetCourseCode = null) {
  if (isSyncingAllocationsToSubjectMapping) return;
  isSyncingAllocationsToSubjectMapping = true;

  try {
    const deptName = (state.currentUser ? state.currentUser.departmentName : '') || '';
    const deptUpper = deptName.trim().toUpperCase();
    const deptCourses = (state.courses || []).filter(c => (c.department || '').trim().toUpperCase() === deptUpper);
    if (deptCourses.length === 0) return;

    const coursesToSync = targetCourseCode
      ? deptCourses.filter(c => {
          const base = (c.code || '').replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
          const targetBase = targetCourseCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
          return c.code === targetCourseCode || base === targetBase || targetCourseCode.startsWith(c.code) || c.code.startsWith(targetCourseCode);
        })
      : deptCourses;

    const allocs = state.allocations || {};

    coursesToSync.forEach(course => {
      const cCode = course.code || '';
      const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');

      // INVARIANT: If this course already has configured hours or teachers in Subject Teacher Mapping,
      // NEVER allow grid allocations to overwrite, drop teachers, or tamper with the practical/theory split!
      const existingSaved = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptUpper] && (state.subjectTeacherMapping[deptUpper][cCode] || state.subjectTeacherMapping[deptUpper][baseCode]));
      const existingLocal = localSubjectMappings[cCode] || localSubjectMappings[baseCode];
      const hasConfiguredMapping = (existingSaved && (existingSaved.theoryHours !== undefined || existingSaved.practicalHours !== undefined || (existingSaved.teachers && existingSaved.teachers.length > 0))) ||
                                   (existingLocal && (existingLocal.theoryHours !== undefined || existingLocal.practicalHours !== undefined || (existingLocal.teachers && existingLocal.teachers.length > 0)));
      if (hasConfiguredMapping) {
        return; // Preserve user's configured subject mapping completely intact!
      }
      const classMatch = cCode.match(/(_C|_G)(\d+)/);
      const classNum = course.classNum || (classMatch ? classMatch[2] : ((course.class && course.class > 0) ? course.class : null));

      // Gather all matching allocation keys for this course
      const candidateKeys = [];
      if (classNum) {
        candidateKeys.push(`${baseCode}_C${classNum}-T`, `${baseCode}_C${classNum}-P`, `${baseCode}_C${classNum}`);
        candidateKeys.push(`${baseCode}_G${classNum}-T`, `${baseCode}_G${classNum}-P`, `${baseCode}_G${classNum}`);
      }
      candidateKeys.push(cCode, `${cCode}-T`, `${cCode}-P`, `${baseCode}-T`, `${baseCode}-P`, baseCode);

      // If course has multiple classes configured (classes > 1), capture class keys as well
      const classesCount = Math.max(1, parseInt(course.classes) || 1);
      if (classesCount > 1) {
        for (let cl = 1; cl <= classesCount; cl++) {
          candidateKeys.push(`${baseCode}_C${cl}-T`, `${baseCode}_C${cl}-P`, `${baseCode}_C${cl}`);
          candidateKeys.push(`${baseCode}_G${cl}-T`, `${baseCode}_G${cl}-P`, `${baseCode}_G${cl}`);
        }
      }

      const uniqueKeys = Array.from(new Set(candidateKeys));

      // Track slots and teachers per class
      const classStats = {};
      let hasAnyAllocation = false;

      uniqueKeys.forEach(key => {
        const dayObj = allocs[key];
        if (!dayObj) return;

        const classMatchInKey = key.match(/(_C|_G)(\d+)/);
        const classId = classMatchInKey ? `C${classMatchInKey[2]}` : (classNum ? `C${classNum}` : 'C1');

        if (!classStats[classId]) {
          classStats[classId] = {
            theorySlots: new Set(),
            practicalSlots: new Set(),
            teacherTheoryCount: {},
            teacherPracCount: {}
          };
        }

        const isKeyPractical = key.endsWith('-P') || key.includes('-P');
        const isKeyTheory = key.endsWith('-T') || key.includes('-T');

        Object.entries(dayObj).forEach(([day, periodObj]) => {
          const dayUpper = day.toUpperCase();
          Object.entries(periodObj || {}).forEach(([period, facList]) => {
            if (!Array.isArray(facList) || facList.length === 0) return;
            if (String(period).toUpperCase() === 'LB') return;

            hasAnyAllocation = true;
            const slotPeriodKey = `${dayUpper}_${period}`;

            // Determine whether this slot is Practical or Theory
            let slotType = 'T';
            if (isKeyPractical) {
              slotType = 'P';
            } else if (isKeyTheory) {
              slotType = 'T';
            } else {
              const rec = (course.recommendations && course.recommendations[dayUpper] && course.recommendations[dayUpper][period]) ||
                          (course.masterRecommendations && course.masterRecommendations[dayUpper] && course.masterRecommendations[dayUpper][period]) || '';
              if (rec === 'P') {
                slotType = 'P';
              } else if (rec === 'T') {
                slotType = 'T';
              } else if (course.courseType === 'P' || cCode.endsWith('-P')) {
                slotType = 'P';
              } else {
                slotType = 'T';
              }
            }

            if (slotType === 'P') {
              classStats[classId].practicalSlots.add(slotPeriodKey);
              facList.forEach(fc => {
                const code = (fc || '').trim();
                if (code) {
                  classStats[classId].teacherPracCount[code] = (classStats[classId].teacherPracCount[code] || 0) + 1;
                }
              });
            } else {
              classStats[classId].theorySlots.add(slotPeriodKey);
              facList.forEach(fc => {
                const code = (fc || '').trim();
                if (code) {
                  classStats[classId].teacherTheoryCount[code] = (classStats[classId].teacherTheoryCount[code] || 0) + 1;
                }
              });
            }
          });
        });
      });

      if (!hasAnyAllocation) return; // Retain baseline if no manual allocations exist for this course

      // Aggregate statistics across classes
      const allClasses = Object.keys(classStats);
      let maxTheorySlots = 0;
      let maxPracSlots = 0;
      allClasses.forEach(clId => {
        const thCount = classStats[clId].theorySlots.size;
        const prCount = classStats[clId].practicalSlots.size;
        if (thCount > maxTheorySlots) maxTheorySlots = thCount;
        if (prCount > maxPracSlots) maxPracSlots = prCount;
      });

      const theoryHours = maxTheorySlots;
      const practicalHours = maxPracSlots;
      const totalWeeklyHours = theoryHours + practicalHours;
      if (totalWeeklyHours === 0) return;

      const isPrac = practicalHours > 0;
      const detectedCourseType = isPrac ? 'P' : 'T';

      // Collect all teachers and their per-teacher hours
      const theoryTeachersSet = new Set();
      const practicalTeachersSet = new Set();
      const theoryTeacherHours = {};

      allClasses.forEach(clId => {
        Object.entries(classStats[clId].teacherTheoryCount).forEach(([fc, count]) => {
          theoryTeachersSet.add(fc);
          const perClassTh = Math.max(1, Math.round(count / (allClasses.length > 1 && count > theoryHours ? allClasses.length : 1)));
          theoryTeacherHours[fc] = Math.max(theoryTeacherHours[fc] || 0, perClassTh);
        });
        Object.keys(classStats[clId].teacherPracCount).forEach(fc => {
          practicalTeachersSet.add(fc);
        });
      });

      const theoryTeachers = Array.from(theoryTeachersSet);
      const practicalTeachers = Array.from(practicalTeachersSet);
      const unifiedTeachers = Array.from(new Set([...practicalTeachers, ...theoryTeachers]));

      // Validate and balance theory teacher hours so their sum matches theoryHours
      let balancedTheoryTeacherHours = {};
      if (theoryTeachers.length > 0 && theoryHours > 0) {
        balancedTheoryTeacherHours = validateAndBalanceTeacherHours(theoryHours, theoryTeachers, theoryTeacherHours);
      }

      // Unified teacher hours across theory and practical
      const unifiedTeacherHours = {};
      unifiedTeachers.forEach(fc => {
        let hrs = 0;
        if (isPrac && practicalTeachers.includes(fc)) {
          hrs += practicalHours; // Co-teaching in lab: teaches all practical hours
        }
        if (theoryTeachers.includes(fc)) {
          hrs += (balancedTheoryTeacherHours[fc] || 0);
        }
        unifiedTeacherHours[fc] = hrs;
      });

      // Update localSubjectMappings for cCode and baseCode
      const updatedMapping = {
        hours: totalWeeklyHours,
        courseType: detectedCourseType,
        practicalHours: isPrac ? practicalHours : 0,
        theoryHours: theoryHours,
        practicalTeachers: isPrac ? practicalTeachers : [],
        theoryTeachers: theoryTeachers,
        theoryTeacherHours: balancedTheoryTeacherHours,
        teachers: unifiedTeachers,
        teacherHours: isPrac ? unifiedTeacherHours : balancedTheoryTeacherHours
      };

      localSubjectMappings[cCode] = updatedMapping;
      if (baseCode && baseCode !== cCode) {
        localSubjectMappings[baseCode] = { ...updatedMapping };
      }

      // Update state.courses object in memory
      const courseObj = state.courses.find(c => c.code === cCode) || state.courses.find(c => c.code === baseCode);
      if (courseObj) {
        courseObj.hours = totalWeeklyHours;
        courseObj.courseType = detectedCourseType;
        courseObj.practicalHours = isPrac ? practicalHours : 0;
        courseObj.theoryHours = theoryHours;
        courseObj.teachers = unifiedTeachers;
        courseObj.teacherHours = isPrac ? unifiedTeacherHours : balancedTheoryTeacherHours;
        courseObj.practicalTeachers = isPrac ? practicalTeachers : [];
        courseObj.theoryTeachers = theoryTeachers;
        courseObj.theoryTeacherHours = balancedTheoryTeacherHours;
      }

      syncAutoGenConfigForCourse(cCode);
      if (baseCode && baseCode !== cCode) {
        syncAutoGenConfigForCourse(baseCode);
      }
    });

    // If Subject Teacher Mapping tab is active/visible, refresh tiles in real time
    const advModal = document.getElementById('modal-advanced-features');
    const subPane = document.getElementById('adv-pane-subject-mapping');
    if (advModal && !advModal.classList.contains('hidden') && subPane && !subPane.classList.contains('hidden')) {
      renderSubjectMappingTiles();
    }
  } catch (err) {
    console.error('Error synchronizing allocations to subject mapping:', err);
  } finally {
    isSyncingAllocationsToSubjectMapping = false;
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

  // Retain pristine user subject mappings without reverse-sync overwrite
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

// Dedicated Subject Teacher Mapping Workload Calculator
// Strictly calculates hours from localSubjectMappings manually configured by the user.
// Has ZERO connection with the live timetable allocations tracker (dept-live-workload).
function updateSubjectMappingWorkloadTracker() {
  const container = document.getElementById('subject-mapping-workload-pills');
  if (!container) return;

  const deptName = state.currentUser ? state.currentUser.departmentName : '';
  const deptNorm = (deptName || '').replace(/^Department\s+of\s+/i, '').trim().toUpperCase();
  const deptFaculty = (state.faculty || []).filter(f => (f.department || '').replace(/^Department\s+of\s+/i, '').trim().toUpperCase() === deptNorm);

  if (deptFaculty.length === 0) {
    container.innerHTML = '<span class="text-muted text-sm">No faculty members found for this department.</span>';
    return;
  }

  // Initialize teacher totals
  const facWorkload = {};
  deptFaculty.forEach(f => {
    facWorkload[f.code] = {
      name: f.name,
      code: f.code,
      totalHours: 0,
      theoryHours: 0,
      practicalHours: 0,
      coursesCount: 0
    };
  });

  // Calculate exclusively from localSubjectMappings for courses in this department
  const deptCourses = (state.courses || []).filter(c => (c.department || '').replace(/^Department\s+of\s+/i, '').trim().toUpperCase() === deptNorm);
  
  deptCourses.forEach(c => {
    const mapping = (typeof localSubjectMappings !== 'undefined' && localSubjectMappings[c.code]) ? localSubjectMappings[c.code] : null;
    if (!mapping) return;

    const isPrac = (mapping.courseType === 'P' || c.courseType === 'P' || c.code.endsWith('-P'));

    if (isPrac) {
      // Practical lab hours: each assigned practical teacher teaches the lab session (co-teaching)
      const pTeachers = Array.isArray(mapping.practicalTeachers) ? mapping.practicalTeachers : [];
      const pHours = (typeof mapping.practicalHours === 'number') ? mapping.practicalHours : 0;
      
      pTeachers.forEach(fc => {
        if (facWorkload[fc]) {
          facWorkload[fc].practicalHours += pHours;
          facWorkload[fc].totalHours += pHours;
          facWorkload[fc].coursesCount++;
        }
      });

      // Theory portion of practical course (if split)
      const tTeachers = Array.isArray(mapping.theoryTeachers) ? mapping.theoryTeachers : [];
      const tHours = (typeof mapping.theoryHours === 'number') ? mapping.theoryHours : 0;
      const thSplit = mapping.theoryTeacherHours || {};

      if (tTeachers.length > 0) {
        tTeachers.forEach(fc => {
          if (facWorkload[fc]) {
            const h = (thSplit[fc] !== undefined) ? parseInt(thSplit[fc]) : Math.max(1, Math.floor(tHours / tTeachers.length));
            facWorkload[fc].theoryHours += h;
            facWorkload[fc].totalHours += h;
            if (!pTeachers.includes(fc)) {
              facWorkload[fc].coursesCount++;
            }
          }
        });
      }
    } else {
      // Pure Theory Course
      const teachers = Array.isArray(mapping.teachers) ? mapping.teachers : (Array.isArray(mapping.theoryTeachers) ? mapping.theoryTeachers : []);
      const totalHrs = parseInt(mapping.hours) || 4;
      const thSplit = mapping.teacherHours || mapping.theoryTeacherHours || {};

      if (teachers.length > 0) {
        teachers.forEach(fc => {
          if (facWorkload[fc]) {
            const h = (thSplit[fc] !== undefined) ? parseInt(thSplit[fc]) : Math.max(1, Math.floor(totalHrs / teachers.length));
            facWorkload[fc].theoryHours += h;
            facWorkload[fc].totalHours += h;
            facWorkload[fc].coursesCount++;
          }
        });
      }
    }
  });

  // Render pills with a leading TOTAL tile
  let totalEntireHours = 0;
  let totalTheoryHours = 0;
  let totalPracticalHours = 0;

  deptFaculty.forEach(f => {
    const data = facWorkload[f.code] || { totalHours: 0, theoryHours: 0, practicalHours: 0 };
    totalEntireHours += data.totalHours;
    totalTheoryHours += data.theoryHours;
    totalPracticalHours += data.practicalHours;
  });

  const totalTileHtml = `
    <div class="mapping-workload-pill mapping-workload-total" title="Entire Assigned Hours (All Teachers in Subject Teacher Mapping)">
      <span class="fac-code"><i class="fa-solid fa-calculator" style="font-size: 11px; margin-right: 3px;"></i>TOTAL</span>
      <span class="fac-hours">${totalEntireHours} hrs</span>
      <div class="fac-detail">
        <span>TH: ${totalTheoryHours}</span> • <span>PR: ${totalPracticalHours}</span>
      </div>
    </div>
  `;

  // Render pills
  container.innerHTML = totalTileHtml + deptFaculty.map(f => {
    const data = facWorkload[f.code] || { totalHours: 0, theoryHours: 0, practicalHours: 0 };
    const badgeColor = data.totalHours > 16 ? '#dc2626' : (data.totalHours === 0 ? '#94a3b8' : '#2563eb');
    return `
      <div class="mapping-workload-pill" title="${f.name} (${f.code})">
        <span class="fac-code">${f.code}</span>
        <span class="fac-hours" style="color: ${badgeColor};">${data.totalHours} hrs</span>
        <div class="fac-detail">
          <span>TH: ${data.theoryHours}</span> • <span>PR: ${data.practicalHours}</span>
        </div>
      </div>
    `;
  }).join('');
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
    const theoryTeachers = isPrac ? (mapping.theoryTeachers || []) : (mapping.teachers || []);
    
    // Ensure hours are strictly validated and balanced
    let theoryTeacherHours;
    if (isPrac) {
      if (theoryTeachers.length > 0 && (mapping.theoryHours || 0) > 0) {
        mapping.theoryTeacherHours = validateAndBalanceTeacherHours(mapping.theoryHours || 0, theoryTeachers, mapping.theoryTeacherHours);
      }
      theoryTeacherHours = mapping.theoryTeacherHours || {};
    } else {
      mapping.teacherHours = validateAndBalanceTeacherHours(mapping.hours, theoryTeachers, mapping.teacherHours);
      mapping.theoryTeacherHours = mapping.teacherHours;
      theoryTeacherHours = mapping.teacherHours || {};
    }
    const practicalTeachers = mapping.practicalTeachers || [];
    const practicalHours = mapping.practicalHours || 2;
    const maxEvenPrac = mapping.hours % 2 === 0 ? mapping.hours : Math.max(2, mapping.hours - 1);

    // Calculate sum of allocated pure theory hours
    const pureTheorySum = theoryTeachers.reduce((acc, t) => acc + (parseInt(theoryTeacherHours[t]) || 0), 0);

    // Calculate sum of practical's theory hours
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

    const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
    const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || c.group || null);
    const classBadgeHtml = classNum ? `<span class="badge" style="background: #e0e7ff; color: #4338ca; font-size: 10px; margin-left: 4px; font-weight: 700; border: 1px solid #c7d2fe;">Class C${classNum}</span>` : '';
    const mapped = c.mappedBatches || [];
    const mappedBatchesHtml = mapped.length > 0
      ? `<span class="badge" style="background: #f1f5f9; color: #334155; font-size: 10px; margin-left: 4px;" title="Mapped Batches: ${mapped.join(', ')}"><i class="fa-solid fa-users"></i> ${mapped.join(', ')}</span>`
      : '';

    html += `
      <div class="subject-tile-card" data-course-code="${c.code}" id="subject-card-${c.code}">
        <!-- Tile Header -->
        <div class="subject-tile-header">
          <div>
            <div class="subject-tile-title">
              ${c.code}
              <span class="badge badge-info" style="font-size: 10px; margin-left: 4px;">Sem ${c.semester}</span>
              ${classBadgeHtml}
              ${mappedBatchesHtml}
            </div>
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
  if (typeof updateSubjectMappingWorkloadTracker === 'function') updateSubjectMappingWorkloadTracker();
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
        const pVal = localSubjectMappings[cCode].practicalHours || 2;
        const tVal = localSubjectMappings[cCode].theoryHours !== undefined ? localSubjectMappings[cCode].theoryHours : Math.max(0, totalHrs - pVal);

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

      // Update practical & theory boxes visibility and headers
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

  // Filter matching common batches and connected courses
  const batches = state.commonBatches || [];
  const userDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
  const myDeptBatches = (state.allBatches || []).filter(b => {
    const bDept = (b.deptCode || b.deptName || b.department || '').trim().toUpperCase();
    return bDept === userDept;
  });
  const myDeptBatchIds = myDeptBatches.map(b => b.batchId);

  // Look up connected courses from Batch Allocation & Mapping
  const lUpper = lockLabel.toUpperCase();
  const lClean = lUpper.replace(/[^A-Z0-9]/g, '');

  const connectedCourses = (state.courses || []).filter(c => {
    const m = getCourseCommonSubjectMatch(c);
    const cat = (c.category || '').toUpperCase();
    const semMatches = !lockSem || lockSem === 'All' || lockSem === 'all' || !c.semester || String(c.semester) === String(lockSem);
    if (!semMatches) return false;
    const subjMatches = (m && (m === lUpper || m.replace(/[^A-Z0-9]/g, '') === lClean)) || cat === lClean || cat === lUpper;
    if (!subjMatches) return false;
    const isOffering = (c.department || '').toUpperCase() === userDept;
    const isMapped = (c.mappedBatches || []).some(bId => myDeptBatchIds.includes(bId));
    return isOffering || isMapped;
  });

  const matchingBatches = batches.filter(b => {
    const bCode = (b.subjectCode || '').toUpperCase();
    const bClean = bCode.replace(/[^A-Z0-9]/g, '');
    const codeMatches = (bCode === lUpper) || (bClean && bClean === lClean) || (b.subjectCode && lUpper.includes(bCode)) || (lUpper && bCode.includes(lUpper));
    const semMatches = !lockSem || lockSem === 'All' || lockSem === 'all' || !b.semester || String(b.semester) === String(lockSem);
    return codeMatches && semMatches;
  });

  const totalConnected = connectedCourses.length > 0 ? connectedCourses.length : matchingBatches.length;

  if (countBadge) {
    countBadge.textContent = `${totalConnected} Class${totalConnected === 1 ? '' : 'es'}`;
  }

  if (container) {
    if (connectedCourses.length > 0) {
      container.innerHTML = connectedCourses.map(c => {
        const isOffering = (c.department || '').toUpperCase() === userDept;
        const classNumMatch = c.code.match(/(_G|_C)(\d+)/);
        const classNum = classNumMatch ? parseInt(classNumMatch[2]) : (c.class || 1);
        const baseCodeOnly = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const mapped = c.mappedBatches || [];

        // Teacher lookup
        const deptUpper = (c.department || '').toUpperCase();
        const teacherMap = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptUpper] && state.subjectTeacherMapping[deptUpper][c.code]) || null;
        let teacherDisplay = 'Pending Dept Mapping';
        if (teacherMap) {
          const tCodes = [...new Set([...(teacherMap.teachers || []), ...(teacherMap.theoryTeachers || []), ...(teacherMap.practicalTeachers || [])])];
          if (tCodes.length > 0) {
            const labels = tCodes.map(tc => {
              const f = (state.faculty || []).find(x => x.code === tc);
              return f ? `${tc} (${f.name})` : tc;
            });
            teacherDisplay = labels.join(', ');
          }
        }

        return `
          <div style="background: #f8faff; border: 1.5px solid #bfdbfe; border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px;">
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
                <span class="badge" style="background: var(--accent); color: var(--accent-dark); font-weight: 700; border: 1.5px solid var(--accent-dark); font-size: 11px; padding: 2px 6px;">Class C${classNum}</span>
                <strong style="font-size: 13px; color: var(--text-main);">${escapeHtml(baseCodeOnly)}</strong>
                <span class="badge badge-info" style="font-size: 9px; padding: 1px 5px;">Offered by: ${escapeHtml(c.department || 'TBD')}</span>
                ${isOffering ? `<span class="badge badge-success" style="font-size: 9px; padding: 1px 5px;"><i class="fa-solid fa-check"></i> Your Dept (Offering)</span>` : `<span class="badge badge-primary" style="font-size: 9px; padding: 1px 5px;"><i class="fa-solid fa-users"></i> Your Dept (Participating)</span>`}
              </div>
              <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 3px;">
                <span>Course Name: <strong style="color: var(--text-main);">${escapeHtml(c.name || '')}</strong></span>
              </div>
              <div style="font-size: 10.5px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <span>Mapped Batches:</span>
                ${mapped.length > 0 ? mapped.map(b => `<span style="background: #e2e8f0; color: #334155; padding: 0 4px; border-radius: 3px; font-size: 9.5px; font-weight: 600;">${escapeHtml(b)}</span>`).join('') : '<span class="text-muted" style="font-style: italic;">No batches mapped</span>'}
              </div>
            </div>
            <div style="text-align: right; flex-shrink: 0;">
              <span class="fac-pill" style="margin: 0; font-weight: 600; font-size: 11px;" title="Assigned Faculty: ${escapeHtml(teacherDisplay)}">
                <i class="fa-solid fa-chalkboard-user"></i> ${escapeHtml(teacherDisplay)}
              </span>
            </div>
          </div>
        `;
      }).join('');
    } else if (matchingBatches.length > 0) {
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
    } else {
      container.innerHTML = `
        <div style="padding: 20px; background: #ffffff; border: 1.5px dashed var(--border); border-radius: 8px; text-align: center;">
          <p class="text-muted text-xs mb-1" style="font-weight: 600;"><i class="fa-solid fa-circle-info text-primary"></i> No courses/batches configured yet for "${escapeHtml(lockLabel)}".</p>
          <span class="text-muted" style="font-size: 11px;">Configure course classes and batch mappings in Admin Portal under <strong>Common Subject Mapping</strong>.</span>
        </div>
      `;
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
      openAdvancedFeaturesModal('adv-pane-subject-mapping');
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

  // Filter by Assignment Status
  const assignFilter = document.getElementById('auto-gen-courses-assignment-filter');
  const assignMode = assignFilter ? assignFilter.value : 'all';
  if (assignMode === 'assigned') {
    deptCourses = deptCourses.filter(c => {
      const b = autoGenCourseFacultyBindings[c.code];
      if (b !== undefined) return b.length > 0;
      const m = localSubjectMappings[c.code] || {};
      const cFacs = m.teachers || c.teachers || [];
      return cFacs.length > 0;
    });
  } else if (assignMode === 'unassigned') {
    deptCourses = deptCourses.filter(c => {
      const b = autoGenCourseFacultyBindings[c.code];
      if (b !== undefined) return b.length === 0;
      const m = localSubjectMappings[c.code] || {};
      const cFacs = m.teachers || c.teachers || [];
      return cFacs.length === 0;
    });
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
      distribute: isPrac ? false : ((!autoGenCourseFacultyConfig[c.code] || autoGenCourseFacultyConfig[c.code].distribute !== false) && autoGenCourseFacultyBindings[c.code].length > 1),
      teacherHours: mapObj.teacherHours || c.teacherHours || null,
      courseType: isPrac ? 'P' : 'T',
      practicalHours: mapObj.practicalHours !== undefined ? mapObj.practicalHours : c.practicalHours,
      theoryHours: mapObj.theoryHours !== undefined ? mapObj.theoryHours : c.theoryHours,
      practicalTeachers: pracTeachers.length > 0 ? pracTeachers : (isPrac ? autoGenCourseFacultyBindings[c.code] : []),
      theoryTeachers: theoryTeachers,
      theoryTeacherHours: mapObj.theoryTeacherHours || c.theoryTeacherHours || null
    };

    const selectedFacs = autoGenCourseFacultyBindings[c.code] || [];
    const isDistribute = !isPrac && (!autoGenCourseFacultyConfig[c.code] || autoGenCourseFacultyConfig[c.code].distribute !== false);

    let summaryText = 'Not Assigned';
    let summaryIcon = 'fa-solid fa-circle-exclamation';
    let summaryIconColor = '#ef4444';
    if (isPrac) {
      if (pracTeachers.length > 1) {
        summaryText = `Co-Teachers: ${pracTeachers.join(', ')} (${pracTeachers.length} in same period)`;
        summaryIcon = 'fa-solid fa-user-group';
        summaryIconColor = 'var(--primary)';
      } else if (selectedFacs.length > 0) {
        summaryText = `Co-Teaching: ${selectedFacs.join(', ')}`;
        summaryIcon = 'fa-solid fa-user-group';
        summaryIconColor = 'var(--primary)';
      }
    } else {
      if (selectedFacs.length === 1) {
        summaryText = `${selectedFacs[0]} (1 Teacher)`;
        summaryIcon = 'fa-solid fa-user';
        summaryIconColor = 'var(--primary)';
      } else if (selectedFacs.length > 1) {
        summaryText = `${selectedFacs.join(', ')} (${selectedFacs.length} Teachers)`;
        summaryIcon = 'fa-solid fa-user-group';
        summaryIconColor = 'var(--primary)';
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
            <button type="button" class="btn btn-outline btn-xs btn-toggle-fac-dropdown" data-course-code="${c.code}" style="font-size: 11px; padding: 4px 8px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; border-color: ${selectedFacs.length > 0 ? 'var(--primary)' : '#fca5a5'}; background: ${selectedFacs.length > 0 ? 'var(--primary-light)' : '#fef2f2'}; color: ${selectedFacs.length > 0 ? 'var(--primary)' : '#b91c1c'}; border-radius: 4px;">
              <i class="${summaryIcon}" style="color: ${summaryIconColor}; font-size: 10px;"></i>
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
    const icon = btn ? btn.querySelector('i:first-child') : null;
    const pillsRow = document.getElementById(`fac-pills-${cCode}`);
    const distBox = document.getElementById(`distribute-box-${cCode}`);

    let text = 'Not Assigned';
    let iconClass = 'fa-solid fa-circle-exclamation';
    let iconColor = '#ef4444';
    if (selected.length === 1) {
      text = `${selected[0]} (1 Teacher)`;
      iconClass = 'fa-solid fa-user';
      iconColor = 'var(--primary)';
    } else if (selected.length > 1) {
      text = `${selected.join(', ')} (${selected.length} Teachers)`;
      iconClass = 'fa-solid fa-user-group';
      iconColor = 'var(--primary)';
    }
    if (label) label.textContent = text;
    if (icon) {
      icon.className = iconClass;
      icon.style.color = iconColor;
    }

    if (btn) {
      btn.style.borderColor = selected.length > 0 ? 'var(--primary)' : '#fca5a5';
      btn.style.background = selected.length > 0 ? 'var(--primary-light)' : '#fef2f2';
      btn.style.color = selected.length > 0 ? 'var(--primary)' : '#b91c1c';
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

  const btnDeselectUnassigned = document.getElementById('btn-auto-gen-deselect-unassigned');
  if (btnDeselectUnassigned) {
    btnDeselectUnassigned.onclick = () => {
      let changed = false;
      container.querySelectorAll('.auto-gen-course-cb').forEach(cb => {
        const cCode = cb.value;
        const facs = autoGenCourseFacultyBindings[cCode] || [];
        if (facs.length === 0 && cb.checked) {
          cb.checked = false;
          changed = true;
        }
      });
      if (changed) {
        updateSelectedCount();
      }
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
      const isLocked = globalLocks.some(l => isPeriodLockedForCourse(l, course, day, p, state.commonBatches || []));
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

// Helper: Detect any teachers who haven't been allocated their full mapped hours
function computeClientUnassignedTeacherHours(selectedCodes, allocations) {
  const list = [];
  if (!Array.isArray(selectedCodes) || !allocations) return list;
  const deptFaculty = state.faculty || [];

  selectedCodes.forEach(cCode => {
    const cObj = state.courses.find(c => c.code === cCode) || { code: cCode };
    const mapping = localSubjectMappings[cCode] || {};
    const cAlloc = allocations[cCode] || {};
    const placedCounts = {};
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    weekdays.forEach(d => {
      Object.keys(cAlloc[d] || {}).forEach(p => {
        const facs = cAlloc[d][p] || [];
        facs.forEach(f => {
          placedCounts[f] = (placedCounts[f] || 0) + 1;
        });
      });
    });

    const isPrac = (mapping.courseType === 'P' || cObj.courseType === 'P');
    if (isPrac) {
      const pracHours = parseInt(mapping.practicalHours !== undefined ? mapping.practicalHours : cObj.practicalHours) || 0;
      const pracTeachers = (mapping.practicalTeachers && mapping.practicalTeachers.length > 0)
        ? mapping.practicalTeachers
        : (cObj.practicalTeachers || []);
      const thTeachers = (mapping.theoryTeachers && mapping.theoryTeachers.length > 0)
        ? mapping.theoryTeachers
        : (cObj.theoryTeachers || []);
      const thTeacherHours = mapping.theoryTeacherHours || mapping.teacherHours || cObj.theoryTeacherHours || {};

      pracTeachers.forEach(f => {
        const placed = placedCounts[f] || 0;
        if (placed < pracHours) {
          const facObj = deptFaculty.find(fc => fc.code === f) || { name: f };
          list.push({
            facultyCode: f,
            facultyName: facObj.name || f,
            courseCode: cCode,
            courseName: cObj.name || cCode,
            courseAlias: cObj.alias || cCode,
            mappedHours: pracHours,
            allocatedHours: placed,
            unassignedHours: pracHours - placed,
            type: 'Practical'
          });
        }
      });

      thTeachers.forEach(f => {
        const expectedTh = parseInt(thTeacherHours[f]) || 0;
        if (expectedTh > 0) {
          const pracPlaced = pracTeachers.includes(f) ? Math.min(placedCounts[f] || 0, pracHours) : 0;
          const thPlaced = Math.max(0, (placedCounts[f] || 0) - pracPlaced);
          if (thPlaced < expectedTh) {
            const facObj = deptFaculty.find(fc => fc.code === f) || { name: f };
            list.push({
              facultyCode: f,
              facultyName: facObj.name || f,
              courseCode: cCode,
              courseName: cObj.name || cCode,
              courseAlias: cObj.alias || cCode,
              mappedHours: expectedTh,
              allocatedHours: thPlaced,
              unassignedHours: expectedTh - thPlaced,
              type: 'Theory'
            });
          }
        }
      });
    } else {
      const thTeachers = (mapping.teachers && mapping.teachers.length > 0) ? mapping.teachers : (cObj.teachers || []);
      const thTeacherHours = mapping.theoryTeacherHours || mapping.teacherHours || cObj.teacherHours || null;
      const totalHours = parseInt(mapping.hours || cObj.hours) || 4;
      const fairQuota = Math.ceil(totalHours / Math.max(1, thTeachers.length));

      thTeachers.forEach(f => {
        const expected = (thTeacherHours && thTeacherHours[f] !== undefined && !isNaN(parseInt(thTeacherHours[f])))
          ? parseInt(thTeacherHours[f])
          : (thTeachers.length > 1 ? fairQuota : totalHours);
        const placed = placedCounts[f] || 0;
        if (placed < expected) {
          const facObj = deptFaculty.find(fc => fc.code === f) || { name: f };
          list.push({
            facultyCode: f,
            facultyName: facObj.name || f,
            courseCode: cCode,
            courseName: cObj.name || cCode,
            courseAlias: cObj.alias || cCode,
            mappedHours: expected,
            allocatedHours: placed,
            unassignedHours: expected - placed,
            type: 'Theory'
          });
        }
      });
    }
  });

  return list;
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
        distribute: isPrac ? false : ((!autoGenCourseFacultyConfig[cCode] || autoGenCourseFacultyConfig[cCode].distribute !== false) && facList.length > 1),
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
    // Target courses being regenerated must not be pre-pinned into initialAllocation,
    // otherwise their slots accumulate, exceed mapped quotas, and cause double-booking clashes.
    (selectedCourseCodes || []).forEach(cCode => {
      if (!coursesToPreserve.includes(cCode)) {
        delete pinnedSlots[cCode];
        delete pinnedSlots[`${cCode}-T`];
        delete pinnedSlots[`${cCode}-P`];
      }
    });
  } else if (Array.isArray(preservedCodes) && preservedCodes.length > 0) {
    // Preserve allocated slots for courses ONLY if explicitly confirmed in preservedCodes
    preservedCodes.forEach(cCode => {
      const existingAlloc = getCourseExistingAllocations(cCode);
      if (existingAlloc) {
        pinnedSlots[cCode] = JSON.parse(JSON.stringify(existingAlloc));
      }
    });
  }

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
      
      const resultsHeading = document.getElementById('auto-gen-results-heading');
      const resultsMsg = document.getElementById('auto-gen-results-msg');

      // Unassigned Teacher Hours & Constraint Violations Display
      let unassignedBoxes = Array.isArray(result.unassignedTeacherHours) ? result.unassignedTeacherHours : [];
      if (unassignedBoxes.length === 0) {
        unassignedBoxes = computeClientUnassignedTeacherHours(selectedCourseCodes, result.allocations || tempGeneratedAllocations);
      }
      const otherViolations = (result.exceptions || []).filter(e => e.type !== 'PARTIAL_ALLOCATION');

      if (unassignedBoxes.length > 0) {
        if (resultsHeading) {
          resultsHeading.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #b45309;"></i> Schedule Generated with Allocation Bottlenecks`;
          resultsHeading.style.color = '#b45309';
        }
        if (resultsCard) {
          resultsCard.style.backgroundColor = '#fffbeb';
          resultsCard.style.borderColor = '#f59e0b';
        }

        const boxesHtml = `
          <div style="margin-top: 10px; margin-bottom: 12px;">
            <div style="font-size: 12px; font-weight: 700; color: #92400e; margin-bottom: 8px;">
              <i class="fa-solid fa-user-clock" style="color: #d97706;"></i> Unassigned Faculty Hours due to Constraints (${unassignedBoxes.length}):
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px;">
              ${unassignedBoxes.map(box => `
                <div style="background: #ffffff; border: 1.5px solid #f59e0b; border-left: 5px solid #d97706; border-radius: 8px; padding: 10px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
                    <div style="font-weight: 700; font-size: 13px; color: #1e293b;">
                      <i class="fa-solid fa-user-xmark" style="color: #d97706; margin-right: 4px;"></i>
                      ${escapeHtml(box.facultyName)} <span style="font-size: 11px; color: #64748b; font-weight: 500;">(${escapeHtml(box.facultyCode)})</span>
                    </div>
                    <span style="background: #fef3c7; color: #b45309; font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 12px; border: 1px solid #fde68a; white-space: nowrap;">
                      ${box.unassignedHours} ${box.unassignedHours === 1 ? 'hr' : 'hrs'} not assigned
                    </span>
                  </div>
                  <div style="font-size: 12px; color: #334155; margin-bottom: 6px; font-weight: 500;">
                    <span style="font-weight: 600; color: #475569;">Course:</span> ${escapeHtml(box.courseName)}
                    <span style="color: #64748b; font-size: 11px;">(${escapeHtml(box.courseAlias || box.courseCode)})</span>
                  </div>
                  <div style="font-size: 11px; color: #64748b; display: flex; gap: 10px; background: #f8fafc; padding: 4px 8px; border-radius: 6px;">
                    <span>Mapped: <strong style="color: #1e293b;">${box.mappedHours}h</strong></span>
                    <span>Allocated: <strong style="color: #10b981;">${box.allocatedHours}h</strong></span>
                    <span>Shortfall: <strong style="color: #dc2626;">${box.unassignedHours}h</strong></span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;

        let otherViolationsHtml = '';
        if (otherViolations.length > 0) {
          otherViolationsHtml = `
            <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #d97706;">
              <div style="font-weight: 700; font-size: 12px; color: #92400e; margin-bottom: 6px;">
                <i class="fa-solid fa-triangle-exclamation" style="color: #d97706;"></i> Other Violated / Relaxed Rules (${otherViolations.length}):
              </div>
              <ul style="margin: 0; padding-left: 20px; font-size: 11px; color: #78350f; line-height: 1.6;">
                ${otherViolations.map(e => `<li>${escapeHtml(e.reason || e.message || String(e))}</li>`).join('')}
              </ul>
            </div>
          `;
        }

        if (resultsMsg) {
          resultsMsg.innerHTML = `
            ${boxesHtml}
            ${otherViolationsHtml}
          `;
        }
      } else if (result.status === 'relaxed_with_exceptions' || otherViolations.length > 0) {
        if (resultsHeading) {
          resultsHeading.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #16a34a;"></i> Generation Feasible with Exceptions`;
          resultsHeading.style.color = '#166534';
        }
        if (resultsCard) {
          resultsCard.style.backgroundColor = 'var(--success-light)';
          resultsCard.style.borderColor = 'var(--success)';
        }
        let otherViolationsHtml = '';
        if (otherViolations.length > 0) {
          otherViolationsHtml = `
            <div style="margin-top: 6px; font-size: 11px; color: #92400e;">
              <strong>Applied Smart Exceptions (${otherViolations.length}):</strong>
              <ul style="margin: 2px 0 0 16px; padding: 0;">
                ${otherViolations.map(e => `<li>${escapeHtml(e.reason || e.message || String(e))}</li>`).join('')}
              </ul>
            </div>
          `;
        }
        if (resultsMsg) {
          resultsMsg.innerHTML = `
            <span style="color: #b45309; font-weight: 700;"><i class="fa-solid fa-triangle-exclamation"></i> Feasible Schedule Generated:</span>
            ${escapeHtml(result.message)}
            ${otherViolationsHtml}
          `;
        }
      } else {
        if (resultsHeading) {
          resultsHeading.innerHTML = `<i class="fa-solid fa-circle-check"></i> Generation Successful!`;
          resultsHeading.style.color = 'var(--success-dark)';
        }
        if (resultsCard) {
          resultsCard.style.backgroundColor = 'var(--success-light)';
          resultsCard.style.borderColor = 'var(--success)';
        }
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
    // When applying allocations for a course, clean up any split variant keys (-T / -P)
    // so stale assignments from prior runs do not remain in state.allocations
    if (!cCode.endsWith('-T') && !cCode.endsWith('-P')) {
      delete state.allocations[`${cCode}-T`];
      delete state.allocations[`${cCode}-P`];
    }
    state.allocations[cCode] = tempGeneratedAllocations[cCode];
    if (!state.allocatedCourseParamSnapshots) state.allocatedCourseParamSnapshots = {};
    state.allocatedCourseParamSnapshots[cCode] = captureCourseParamSnapshot(cCode);
  });
  try {
    sessionStorage.setItem('allocatedCourseParamSnapshots', JSON.stringify(state.allocatedCourseParamSnapshots));
  } catch (e) {}

  tempGeneratedAllocations = null;
  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();

  // Persist directly to backend immediately
  const deptName = state.currentUser ? state.currentUser.departmentName : '';
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
    closeAdvancedFeaturesModal();
    if (!saveRes.ok) {
      showModalAlert('Save Notice', 'Schedule applied to workspace, but saving draft failed: ' + result.message, 'warning');
    } else {
      showModalAlert('Schedule Applied & Saved', 'The auto-generated schedule has been applied to your timetable workspace and saved as draft!', 'success');
      const statusEl = document.getElementById('autosave-status');
      if (statusEl) {
        statusEl.textContent = `Draft autosaved at ${new Date().toLocaleTimeString()}`;
      }
    }
  } catch (err) {
    console.error(err);
    closeAdvancedFeaturesModal();
    showModalAlert('Schedule Applied', 'The schedule is loaded in workspace, but network error prevented saving draft.', 'warning');
  }
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

// Helper to match curriculum semester across formats (e.g. "4", "4_UG", "Sem 4", etc.)
function isMatchingCurriculumSem(semA, semB) {
  if (!semA || !semB) return false;
  const sA = String(semA).replace(/^Sem(ester)?\s*/i, '').trim();
  const sB = String(semB).replace(/^Sem(ester)?\s*/i, '').trim();
  if (sA.toLowerCase() === sB.toLowerCase()) return true;

  const digA = sA.replace(/\D+/g, '');
  const digB = sB.replace(/\D+/g, '');
  if (!digA || !digB || digA !== digB) return false;

  const progA = (sA.match(/UG|PG/i) || [''])[0].toUpperCase();
  const progB = (sB.match(/UG|PG/i) || [''])[0].toUpperCase();

  // If both have program type specified, they MUST match (UG !== PG)
  if (progA && progB) {
    return progA === progB;
  }

  // If one or both lack explicit program type, infer from active program filter
  const progSelect = typeof document !== 'undefined' ? document.getElementById('curriculum-program-select') : null;
  const activeProg = (progSelect && progSelect.value) ? progSelect.value.toUpperCase() : '';
  const effProgA = progA || activeProg || 'UG';
  const effProgB = progB || activeProg || 'UG';
  return effProgA === effProgB;
}

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
            curriculumSelectedFilterCourse = targetSelect.value;
            renderCurriculumSlotMatrix();
            renderCurriculumHoursBreakdown();
          }
        } else if (curriculumActiveToolMode === 'B') {
          targetLabel.innerHTML = `<i class="fa-solid fa-ban"></i> Block Target:`;
        } else if (curriculumActiveToolMode === 'CLEAR') {
          targetLabel.innerHTML = `<i class="fa-solid fa-eraser"></i> Clear Target:`;
        }
      }
    });
  });

  // Program Select Filter
  const progSelect = document.getElementById('curriculum-program-select');
  if (progSelect) {
    progSelect.addEventListener('change', () => {
      populateCurriculumSemesterDropdown();
      populateCurriculumCourseDropdowns();
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
    });
  }

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

  // Target Subject Select (Filters matrix by selected subject and selects target for assignment)
  const targetSelect = document.getElementById('curriculum-target-subject-select');
  if (targetSelect) {
    targetSelect.addEventListener('change', () => {
      curriculumSelectedFilterCourse = targetSelect.value;
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

  // Copy / Transfer Structure to Other Courses Buttons
  const btnCopyStructure = document.getElementById('btn-copy-curriculum-structure');
  if (btnCopyStructure) {
    btnCopyStructure.addEventListener('click', () => {
      openCopyCurriculumModal();
    });
  }

  const btnHeaderCopy = document.getElementById('btn-header-copy-curriculum-slots');
  if (btnHeaderCopy) {
    btnHeaderCopy.addEventListener('click', () => {
      openCopyCurriculumModal();
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
    const seenBlocks = new Set();
    globalLocks.forEach(l => {
      const isBlocked = (l.label || '').toUpperCase().startsWith('BLOCKED');
      const lDept = String(l.department || '').trim().toUpperCase();
      const deptMatch = !lDept || lDept === deptName;
      if (isBlocked && l.day && l.period && deptMatch) {
        const s = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
        const d = l.day.toUpperCase();
        const p = String(l.period).trim();
        const key = `${d}-${p}-${s.toUpperCase()}`;
        if (!seenBlocks.has(key)) {
          seenBlocks.add(key);
          localCurriculumSemesterBlocks.push({
            day: d,
            period: p,
            semester: s,
            department: deptName,
            label: 'Blocked'
          });
        }
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
  
  const progSelect = document.getElementById('curriculum-program-select');
  const activeProg = progSelect ? progSelect.value : '';

  if (sem) {
    let targetSem = String(sem).trim();
    let targetProg = '';
    if (targetSem.includes('_')) {
      const parts = targetSem.split('_');
      targetSem = parts[0];
      targetProg = parts[1];
    } else if (activeProg) {
      targetProg = activeProg;
    }

    const semClean = targetSem.replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    list = list.filter(c => {
      const cSem = String(c.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
      const matchSem = (cSem === semClean);
      const matchProg = !targetProg || ((c.programType || 'UG') === targetProg);
      return matchSem && matchProg;
    });
  } else if (activeProg) {
    list = list.filter(c => (c.programType || 'UG') === activeProg);
  }

  return list;
}

function getCourseHourTargets(baseCode, semCourses) {
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  const savedMappings = (state.subjectTeacherMapping && state.subjectTeacherMapping[deptName]) || {};

  // Helper to fetch mapping for a specific code from localSubjectMappings or savedMappings
  const getMappingForCode = (code) => {
    if (typeof localSubjectMappings !== 'undefined' && localSubjectMappings[code]) {
      return localSubjectMappings[code];
    }
    if (savedMappings[code]) {
      return savedMappings[code];
    }
    return null;
  };

  // 1. Direct check on baseCode in Subject Teacher Mapping
  const directMap = getMappingForCode(baseCode);
  if (directMap) {
    const isPrac = (directMap.courseType === 'P');
    const totalH = parseInt(directMap.hours) || 4;
    const th = directMap.theoryHours !== undefined && directMap.theoryHours !== null 
      ? parseInt(directMap.theoryHours) 
      : (isPrac ? 0 : totalH);
    const pr = directMap.practicalHours !== undefined && directMap.practicalHours !== null 
      ? parseInt(directMap.practicalHours) 
      : (isPrac ? totalH : 0);
    if (!isNaN(th) && !isNaN(pr)) {
      return { thTarget: th, prTarget: pr, total: th + pr };
    }
  }

  // 1b. Check if separate -T and -P mappings exist for this baseCode in Subject Teacher Mapping
  const tMap = getMappingForCode(`${baseCode}-T`);
  const pMap = getMappingForCode(`${baseCode}-P`);
  if (tMap || pMap) {
    let th = 0;
    let pr = 0;
    if (tMap) {
      th = tMap.theoryHours !== undefined ? parseInt(tMap.theoryHours) : (parseInt(tMap.hours) || 2);
    }
    if (pMap) {
      pr = pMap.practicalHours !== undefined ? parseInt(pMap.practicalHours) : (parseInt(pMap.hours) || 2);
    }
    const finalTh = isNaN(th) ? 0 : th;
    const finalPr = isNaN(pr) ? 0 : pr;
    return { thTarget: finalTh, prTarget: finalPr, total: finalTh + finalPr };
  }

  // 1c. Check any course in semCourses matching this baseCode for saved Subject Teacher Mappings
  const matchingCourses = (semCourses || []).filter(c => {
    const b = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    return b === baseCode;
  });

  for (const c of matchingCourses) {
    const cMap = getMappingForCode(c.code);
    if (cMap) {
      const isPrac = (cMap.courseType === 'P' || c.code.endsWith('-P') || c.courseType === 'P');
      const totalH = parseInt(cMap.hours || c.hours) || 4;
      const th = cMap.theoryHours !== undefined && cMap.theoryHours !== null 
        ? parseInt(cMap.theoryHours) 
        : (isPrac ? 0 : totalH);
      const pr = cMap.practicalHours !== undefined && cMap.practicalHours !== null 
        ? parseInt(cMap.practicalHours) 
        : (isPrac ? totalH : 0);
      if (!isNaN(th) && !isNaN(pr)) {
        return { thTarget: th, prTarget: pr, total: th + pr };
      }
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
  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');

  let isP = false;
  let detectedBase = targetBaseCode;

  for (const c of semCourses) {
    const b = cleanBase(c.code);
    const rec = localCurriculumCourseRecs[c.code]?.[day]?.[pStr];
    if (rec === 'P') {
      if (!targetBaseCode || targetBaseCode === 'ALL' || b === targetBaseCode) {
        isP = true;
        detectedBase = b;
        break;
      }
    }
  }
  if (!isP) return null;

  const checkSlotIsP = (pCheck) => {
    return semCourses.some(c => {
      const b = cleanBase(c.code);
      return b === detectedBase && localCurriculumCourseRecs[c.code]?.[day]?.[String(pCheck)] === 'P';
    });
  };

  // Only valid pairs: ['1', '2'], ['4', '5'], ['5', '6']
  if (pStr === '1' && checkSlotIsP('2')) return ['1', '2'];
  if (pStr === '2' && checkSlotIsP('1')) return ['1', '2'];
  if (pStr === '4' && checkSlotIsP('5')) return ['4', '5'];
  if (pStr === '5') {
    if (checkSlotIsP('4')) return ['4', '5'];
    if (checkSlotIsP('6')) return ['5', '6'];
    return ['4', '5'];
  }
  if (pStr === '6' && checkSlotIsP('5')) return ['5', '6'];
  if (pStr === '3') return ['3'];

  return getPracticalPeriodPair(pStr) || [pStr];
}

function populateCurriculumSemesterDropdown() {
  const semSelect = document.getElementById('curriculum-sem-select');
  if (!semSelect) return;

  const progSelect = document.getElementById('curriculum-program-select');
  const activeProg = progSelect ? progSelect.value : '';

  // Get all department courses
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  let deptCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === deptName);
  if (activeProg) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === activeProg);
  }

  const pairs = [];
  deptCourses.forEach(c => {
    const prog = c.programType || 'UG';
    const s = String(c.semester || '1').replace(/^Sem(ester)?\s*/i, '').trim();
    const key = `${s}_${prog}`;
    if (!pairs.some(p => p.val === key)) {
      pairs.push({ val: key, sem: s, prog });
    }
  });

  // Sort by program then semester
  pairs.sort((a, b) => {
    if (a.prog !== b.prog) return a.prog.localeCompare(b.prog);
    return (parseInt(a.sem || 0) - parseInt(b.sem || 0));
  });

  const curVal = semSelect.value;
  semSelect.innerHTML = '';
  pairs.forEach(p => {
    const progLabel = p.prog === 'PG' ? 'MSc / PG' : 'BSc / UG';
    semSelect.innerHTML += `<option value="${p.val}">Semester ${p.sem} (${progLabel})</option>`;
  });

  if (curVal && pairs.some(p => p.val === curVal)) {
    semSelect.value = curVal;
  } else if (pairs.length > 0) {
    semSelect.value = pairs[0].val;
  }
  curriculumSelectedSem = semSelect.value;
}

function populateCurriculumCourseDropdowns() {
  const targetSelect = document.getElementById('curriculum-target-subject-select');
  if (!targetSelect) return;

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

  // Target Subject select (also drives matrix filtering)
  const curTargetVal = targetSelect.value;
  let targetHtml = '<option value="ALL">All Subjects in Semester</option>';
  uniqueBases.forEach(u => {
    targetHtml += `<option value="${u.baseCode}">${escapeHtml(u.baseCode)} - ${escapeHtml(u.name)}</option>`;
  });
  targetSelect.innerHTML = targetHtml;

  if (curTargetVal && (curTargetVal === 'ALL' || uniqueBases.some(u => u.baseCode === curTargetVal))) {
    targetSelect.value = curTargetVal;
  } else {
    targetSelect.value = 'ALL';
  }

  // If active mode is T or P and "ALL" is selected, choose first course
  if ((curriculumActiveToolMode === 'T' || curriculumActiveToolMode === 'P') && targetSelect.value === 'ALL' && uniqueBases.length > 0) {
    targetSelect.value = uniqueBases[0].baseCode;
  }

  curriculumSelectedFilterCourse = targetSelect.value;
}

function renderCurriculumSlotAllocator() {
  if (typeof initLocalSubjectMappings === 'function') {
    initLocalSubjectMappings();
  }
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
  const progSelect = document.getElementById('curriculum-program-select');
  const activeProg = (progSelect && progSelect.value) ? progSelect.value.toUpperCase() : ((String(curriculumSelectedSem).match(/UG|PG/i) || ['UG'])[0].toUpperCase());
  const semNum = String(curriculumSelectedSem).replace(/\D+/g, '');
  const canonicalSem = `${semNum}_${activeProg}`;
  const activeSemStr = canonicalSem;

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
        return b.day === day && String(b.period) === String(p) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem);
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
          const otherRecs = recCourses.filter(rc => rc.baseCode !== curriculumSelectedFilterCourse);
          const badgeBg = thisRec.recType === 'T' ? 'var(--warning)' : 'var(--success)';
          const badgeLabel = thisRec.recType === 'T' ? 'Theory (TH)' : 'Practical (PR)';
          const badgeIcon = thisRec.recType === 'T' ? 'fa-book' : 'fa-flask';
          const cellClass = (thisRec.recType === 'T' ? 'slot-recommend-t' : 'slot-recommend-p');

          bodyHtml += `
            <td class="curriculum-slot-cell ${cellClass}" 
                onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
                title="${escapeHtml(thisRec.baseCode)} - ${escapeHtml(thisRec.course.name || '')} (${badgeLabel})${otherRecs.length > 0 ? ` (+${otherRecs.length} other subjects share slot)` : ''}. Click to change or toggle off."
                style="vertical-align: middle; height: 58px; padding: 4px 6px;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
                <span class="badge" style="background: ${badgeBg}; color: #ffffff; font-size: 9.5px; padding: 1px 6px; font-weight: 700; border-radius: 4px;">
                  <i class="fa-solid ${badgeIcon}"></i> ${badgeLabel}
                </span>
                <strong style="font-size: 12.5px; color: var(--text-main);">${escapeHtml(thisRec.baseCode)}</strong>
                <span style="font-size: 9.5px; color: var(--text-muted); max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(thisRec.course.name || '')}
                </span>
                ${otherRecs.length > 0 ? `
                  <span style="font-size: 8.5px; color: #4338ca; font-weight: 700;" title="Shared with: ${otherRecs.map(r => r.baseCode).join(', ')}">
                    +${otherRecs.length} other subject${otherRecs.length > 1 ? 's' : ''}
                  </span>
                ` : ''}
              </div>
            </td>
          `;
          return;
        }

        // Open slot for this filtered course (check if other courses occupy slot)
        const otherRecs = recCourses;
        if (otherRecs.length > 0) {
          bodyHtml += `
            <td class="curriculum-slot-cell" 
                onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
                title="Open for ${escapeHtml(curriculumSelectedFilterCourse)} (Occupied by: ${otherRecs.map(r => `${r.baseCode} [${r.recType}]`).join(', ')}). Click with selected tool to assign or block."
                style="vertical-align: middle; height: 58px; background: #ffffff;">
              <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
                <div style="color: #94a3b8; font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px;">
                  <i class="fa-solid fa-plus opacity-40"></i> Open
                </div>
                <span style="font-size: 8.5px; color: #64748b; font-weight: 600;" title="${otherRecs.map(r => `${r.baseCode} (${r.recType})`).join(', ')}">
                  (${otherRecs.length} other subject${otherRecs.length > 1 ? 's' : ''})
                </span>
              </div>
            </td>
          `;
          return;
        }

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
        const isMultiple = recCourses.length > 1;
        const cellClass = isMultiple ? 'slot-recommend-multiple' : (recCourses[0].recType === 'T' ? 'slot-recommend-t' : 'slot-recommend-p');

        bodyHtml += `
          <td class="curriculum-slot-cell ${cellClass}" 
              onclick="handleCurriculumSlotCellClick('${day}', '${p}')" 
              title="${recCourses.map(rc => `${rc.baseCode} (${rc.recType === 'T' ? 'Theory' : 'Practical'})`).join(', ')}. Click to change or toggle off."
              style="vertical-align: middle; height: 58px; padding: 3px 5px;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
              ${recCourses.slice(0, 2).map(rc => `
                <div style="display: flex; align-items: center; gap: 4px;">
                  <span class="badge" style="background: ${rc.recType === 'T' ? 'var(--warning)' : 'var(--success)'}; color: #ffffff; font-size: 8px; padding: 0px 4px; font-weight: 700; border-radius: 3px;">
                    ${rc.recType === 'T' ? 'TH' : 'PR'}
                  </span>
                  <strong style="font-size: 11px; color: var(--text-main);">${escapeHtml(rc.baseCode)}</strong>
                </div>
              `).join('')}
              ${recCourses.length > 2 ? `
                <span style="font-size: 8px; color: #4338ca; font-weight: 700;">+${recCourses.length - 2} more</span>
              ` : ''}
              ${blockedCourses.length > 0 ? `
                <span style="font-size: 8px; color: #dc2626; font-weight: 700;" title="Also blocked for: ${blockedCourses.join(', ')}">
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

  const progSelect = document.getElementById('curriculum-program-select');
  const activeProg = (progSelect && progSelect.value) ? progSelect.value.toUpperCase() : ((String(curriculumSelectedSem).match(/UG|PG/i) || ['UG'])[0].toUpperCase());
  const semNum = String(curriculumSelectedSem).replace(/\D+/g, '');
  const canonicalSem = (String(curriculumSelectedSem).includes('_')) ? String(curriculumSelectedSem).trim() : (semNum + '_' + activeProg);
  const activeSemStr = canonicalSem;
  const deptCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  const assignSelect = document.getElementById('curriculum-target-subject-select');
  let targetBaseCode = assignSelect ? assignSelect.value : 'ALL';
  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // D. Check Entire Semester Block
  // If the slot is an entire semester block:
  // - Clicking with 'B' or 'CLEAR' unblocks the semester completely.
  // - Clicking with 'T' or 'P' warns that the semester is completely blocked.
  // -------------------------------------------------------------
  const isSemBlocked = localCurriculumSemesterBlocks.some(b => {
    return b.day === day && String(b.period) === String(period) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem);
  });

  if (isSemBlocked) {
    if (curriculumActiveToolMode === 'B' || curriculumActiveToolMode === 'CLEAR') {
      // Cleanly remove ALL matching semester blocks for this slot (prevents duplicate persistence)
      localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b =>
        !(b.day === day && String(b.period) === String(period) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem))
      );
      // Also clear any course-specific blocks on this slot
      deptCourses.forEach(c => {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });
      renderCurriculumSlotMatrix();
      renderCurriculumHoursBreakdown();
      return;
    } else {
      showModalAlert(
        'Semester Blocked',
        `This period is completely blocked for <strong>Semester ${escapeHtml(activeSemStr)}</strong>.<br><span class="text-muted text-xs">Use the Block tool or Clear tool to unblock the semester before assigning a course.</span>`,
        'warning'
      );
      return;
    }
  }

  // -------------------------------------------------------------
  // 1. Tool: Block Slot ('B')
  // Course-specific Block vs Entire Semester Block
  // -------------------------------------------------------------
  if (curriculumActiveToolMode === 'B') {
    if (targetBaseCode && targetBaseCode !== 'ALL') {
      // Course-specific block: ONLY the selected course is blocked on this day/period
      const targetCourses = deptCourses.filter(c => cleanBase(c.code) === targetBaseCode);

      const isAlreadyBlocked = targetCourses.some(c => 
        localCurriculumCourseRecs[c.code] && 
        localCurriculumCourseRecs[c.code][day] && 
        localCurriculumCourseRecs[c.code][day][period] === 'B'
      );

      if (isAlreadyBlocked) {
        // Toggle OFF (unblock this specific course)
        targetCourses.forEach(c => {
          if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
            delete localCurriculumCourseRecs[c.code][day][period];
          }
        });
      } else {
        // Toggle ON (block this specific course only - other courses in semester remain unblocked)
        targetCourses.forEach(c => {
          if (!localCurriculumCourseRecs[c.code]) localCurriculumCourseRecs[c.code] = {};
          if (!localCurriculumCourseRecs[c.code][day]) localCurriculumCourseRecs[c.code][day] = {};
          localCurriculumCourseRecs[c.code][day][period] = 'B';
        });
      }
    } else {
      // Entire Semester Block or Toggle OFF Course Blocks when in ALL view:
      const anyCourseBlocked = deptCourses.some(c => 
        localCurriculumCourseRecs[c.code] && 
        localCurriculumCourseRecs[c.code][day] && 
        localCurriculumCourseRecs[c.code][day][period] === 'B'
      );

      if (anyCourseBlocked) {
        // If courses are currently blocked, clicking with Block tool toggles them OFF (unblocks)
        deptCourses.forEach(c => {
          if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
            delete localCurriculumCourseRecs[c.code][day][period];
          }
        });
      } else {
        // Entire Semester Block: Completely blocks ALL courses in this semester
        deptCourses.forEach(c => {
          if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
            delete localCurriculumCourseRecs[c.code][day][period];
          }
        });

        // Filter out any existing block first to prevent duplicates
        localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b =>
          !(b.day === day && String(b.period) === String(period) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem))
        );

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

  // -------------------------------------------------------------
  // 2. Tool: Clear Slot ('CLEAR')
  // -------------------------------------------------------------
  if (curriculumActiveToolMode === 'CLEAR') {
    if (targetBaseCode && targetBaseCode !== 'ALL') {
      // Clear ONLY for the selected course
      const targetCourses = deptCourses.filter(c => cleanBase(c.code) === targetBaseCode);
      targetCourses.forEach(c => {
        if (localCurriculumCourseRecs[c.code] && localCurriculumCourseRecs[c.code][day]) {
          delete localCurriculumCourseRecs[c.code][day][period];
        }
      });
    } else {
      // Clear entire semester block and all courses in this slot
      localCurriculumSemesterBlocks = localCurriculumSemesterBlocks.filter(b => {
        return !(b.day === day && String(b.period) === String(period) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem));
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
      return !(b.day === day && String(b.period) === String(period) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem));
    });

    // Assign 'T' to target subject (allows other subjects to also have recommendations in the same period)
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
      return !(b.day === day && pairToAssign.includes(String(b.period)) && isMatchingCurriculumSem(b.semester, curriculumSelectedSem));
    });

    // Assign 'P' to both periods in pairToAssign for target subject (allows other subjects to also have recommendations)
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
           style="border: 1px solid var(--border); background: #ffffff; cursor: default; user-select: none;" 
           title="${escapeHtml(u.baseCode)} - ${escapeHtml(u.name)} (Target: ${u.thTarget}h Theory${u.prTarget > 0 ? ', ' + u.prTarget + 'h Practical' : ''})">
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
// Copy / Transfer Curriculum Slot Structure & Blocks
// -------------------------------------------------------------
function openCopyCurriculumModal() {
  const modal = document.getElementById('modal-copy-curriculum-slots');
  if (!modal) return;

  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');

  // Extract unique bases from the currently filtered semester
  const uniqueBases = [];
  semCourses.forEach(c => {
    const baseCode = cleanBase(c.code);
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

  if (uniqueBases.length <= 1) {
    showModalAlert(
      'Not Enough Courses',
      `There is only ${uniqueBases.length} course registered under the current semester filter. At least two courses are needed to copy and transfer schedule structure.`,
      'info'
    );
    return;
  }

  // Populate source dropdown
  const sourceSelect = document.getElementById('copy-curriculum-source-select');
  if (sourceSelect) {
    const curAssignVal = document.getElementById('curriculum-target-subject-select') ? document.getElementById('curriculum-target-subject-select').value : '';
    let selectedSource = (curAssignVal && curAssignVal !== 'ALL') ? curAssignVal : uniqueBases[0].baseCode;

    sourceSelect.innerHTML = uniqueBases.map(u => {
      const isSel = (u.baseCode === selectedSource) ? 'selected' : '';
      return `<option value="${escapeHtml(u.baseCode)}" ${isSel}>${escapeHtml(u.baseCode)} - ${escapeHtml(u.name)} (${u.totalHours} hrs)</option>`;
    }).join('');

    sourceSelect.onchange = () => {
      updateCopyCurriculumSourceSummary();
      renderCopyCurriculumTargetList();
    };
  }

  // Bind modal close buttons
  const btnClose = document.getElementById('btn-close-copy-curriculum-modal');
  if (btnClose) {
    btnClose.onclick = () => modal.classList.add('hidden');
  }
  const btnCancel = document.getElementById('btn-cancel-copy-curriculum');
  if (btnCancel) {
    btnCancel.onclick = () => modal.classList.add('hidden');
  }

  // Search input
  const searchInput = document.getElementById('copy-target-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll('#copy-target-courses-list .copy-target-item').forEach(el => {
        const text = (el.getAttribute('data-code') + ' ' + el.getAttribute('data-name')).toLowerCase();
        if (!q || text.includes(q)) {
          el.style.display = 'flex';
        } else {
          el.style.display = 'none';
        }
      });
    };
  }

  // Select All / Deselect All
  const btnSelectAll = document.getElementById('btn-copy-select-all');
  if (btnSelectAll) {
    btnSelectAll.onclick = () => {
      document.querySelectorAll('#copy-target-courses-list .copy-target-cb').forEach(cb => {
        const item = cb.closest('.copy-target-item');
        if (item && item.style.display !== 'none') {
          cb.checked = true;
        }
      });
      updateCopyTargetSelectedCount();
    };
  }

  const btnDeselectAll = document.getElementById('btn-copy-deselect-all');
  if (btnDeselectAll) {
    btnDeselectAll.onclick = () => {
      document.querySelectorAll('#copy-target-courses-list .copy-target-cb').forEach(cb => {
        cb.checked = false;
      });
      updateCopyTargetSelectedCount();
    };
  }

  // Confirm Transfer Button
  const btnConfirm = document.getElementById('btn-confirm-copy-curriculum');
  if (btnConfirm) {
    btnConfirm.onclick = () => {
      executeCopyCurriculumStructure();
    };
  }

  updateCopyCurriculumSourceSummary();
  renderCopyCurriculumTargetList();
  modal.classList.remove('hidden');
}

function updateCopyCurriculumSourceSummary() {
  const summaryEl = document.getElementById('copy-curriculum-source-summary');
  const sourceSelect = document.getElementById('copy-curriculum-source-select');
  if (!summaryEl || !sourceSelect) return;

  const sourceBase = sourceSelect.value;
  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);
  const matchingCourses = semCourses.filter(c => cleanBase(c.code) === sourceBase);

  let thCount = 0;
  let prCount = 0;
  let blockCount = 0;
  const seenSlots = new Set();

  matchingCourses.forEach(c => {
    const recs = localCurriculumCourseRecs[c.code] || {};
    Object.keys(recs).forEach(day => {
      Object.keys(recs[day]).forEach(p => {
        const key = `${day}_${p}`;
        if (!seenSlots.has(key)) {
          seenSlots.add(key);
          const val = recs[day][p];
          if (val === 'T') thCount++;
          else if (val === 'P') prCount++;
          else if (val === 'B') blockCount++;
        }
      });
    });
  });

  const totalSlots = thCount + prCount + blockCount;

  let html = `
    <span class="badge" style="background: var(--warning-light); color: var(--warning-dark); font-weight: 600; font-size: 11px; padding: 3px 8px; border-radius: 4px;">
      <i class="fa-solid fa-book"></i> Theory (TH): ${thCount} slots
    </span>
    <span class="badge" style="background: var(--success-light); color: var(--success-dark); font-weight: 600; font-size: 11px; padding: 3px 8px; border-radius: 4px;">
      <i class="fa-solid fa-flask"></i> Practical (PR): ${prCount} slots
    </span>
    <span class="badge" style="background: #fee2e2; color: #991b1b; font-weight: 600; font-size: 11px; padding: 3px 8px; border-radius: 4px;">
      <i class="fa-solid fa-ban"></i> Blocked (B): ${blockCount} slots
    </span>
    <span class="text-muted" style="margin-left: 4px; font-weight: 500;">Total: <strong>${totalSlots}</strong> periods</span>
  `;

  if (totalSlots === 0) {
    html += `
      <div style="width: 100%; color: #b45309; font-weight: 600; margin-top: 4px;">
        <i class="fa-solid fa-triangle-exclamation"></i> Notice: This source course currently has no recommended slots or blocks configured.
      </div>
    `;
  }

  summaryEl.innerHTML = html;
}

function renderCopyCurriculumTargetList() {
  const container = document.getElementById('copy-target-courses-list');
  const sourceSelect = document.getElementById('copy-curriculum-source-select');
  if (!container || !sourceSelect) return;

  const sourceBase = sourceSelect.value;
  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const semCourses = getCurriculumDeptCourses(curriculumSelectedSem);

  // Extract unique bases excluding the sourceBase
  const targetBases = [];
  semCourses.forEach(c => {
    const baseCode = cleanBase(c.code);
    if (baseCode !== sourceBase && !targetBases.some(u => u.baseCode === baseCode)) {
      const targets = getCourseHourTargets(baseCode, semCourses);
      targetBases.push({
        baseCode,
        name: c.name || baseCode,
        totalHours: targets.total,
        thTarget: targets.thTarget,
        prTarget: targets.prTarget
      });
    }
  });

  if (targetBases.length === 0) {
    container.innerHTML = `<div class="text-muted text-xs p-2 text-center">No other courses found in this semester filter.</div>`;
    updateCopyTargetSelectedCount();
    return;
  }

  let html = '';
  targetBases.forEach(u => {
    // Count existing slots on this target course
    const matchingCourses = semCourses.filter(c => cleanBase(c.code) === u.baseCode);
    let existingCount = 0;
    const seen = new Set();
    matchingCourses.forEach(c => {
      const recs = localCurriculumCourseRecs[c.code] || {};
      Object.keys(recs).forEach(day => {
        Object.keys(recs[day]).forEach(p => {
          const key = `${day}_${p}`;
          if (!seen.has(key)) {
            seen.add(key);
            existingCount++;
          }
        });
      });
    });

    const existingBadge = existingCount > 0
      ? `<span class="badge" style="background: #e2e8f0; color: #475569; font-size: 10.5px; padding: 2px 6px;">${existingCount} existing slot(s)</span>`
      : `<span class="badge" style="background: #f1f5f9; color: #94a3b8; font-size: 10.5px; padding: 2px 6px;">0 slots</span>`;

    html += `
      <label class="copy-target-item" data-code="${escapeHtml(u.baseCode)}" data-name="${escapeHtml(u.name)}"
        style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; margin-bottom: 4px; border-radius: 4px; border: 1px solid var(--border); background: #f8fafc; cursor: pointer; transition: all 0.15s ease;">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <input type="checkbox" class="copy-target-cb" value="${escapeHtml(u.baseCode)}" style="cursor: pointer; width: 16px; height: 16px; flex-shrink: 0;">
          <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            <span class="bold" style="font-size: 12.5px; color: var(--primary);">${escapeHtml(u.baseCode)}</span>
            <span class="text-muted" style="font-size: 12px; margin-left: 6px;">${escapeHtml(u.name)}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: 8px;">
          <span class="badge badge-light" style="font-size: 10.5px; padding: 2px 6px;">${u.totalHours} hrs</span>
          ${existingBadge}
        </div>
      </label>
    `;
  });

  container.innerHTML = html;

  // Bind change events
  container.querySelectorAll('.copy-target-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      updateCopyTargetSelectedCount();
    });
  });

  updateCopyTargetSelectedCount();
}

function updateCopyTargetSelectedCount() {
  const checked = document.querySelectorAll('#copy-target-courses-list .copy-target-cb:checked');
  const countEl = document.getElementById('copy-target-selected-count');
  if (countEl) {
    countEl.textContent = `${checked.length} Selected`;
    if (checked.length > 0) {
      countEl.className = 'badge badge-success text-xs';
    } else {
      countEl.className = 'badge badge-primary text-xs';
    }
  }
}

function executeCopyCurriculumStructure() {
  const sourceSelect = document.getElementById('copy-curriculum-source-select');
  if (!sourceSelect) return;
  const sourceBase = sourceSelect.value;
  if (!sourceBase) {
    showModalAlert('Select Source Course', 'Please select a source course to copy from.', 'warning');
    return;
  }

  const checkedBoxes = Array.from(document.querySelectorAll('#copy-target-courses-list .copy-target-cb:checked'));
  const targetCodes = checkedBoxes.map(cb => cb.value);

  if (targetCodes.length === 0) {
    showModalAlert('No Target Courses', 'Please select at least one course from the list to transfer the structure to.', 'warning');
    return;
  }

  const optRecs = document.getElementById('copy-opt-recommendations') ? document.getElementById('copy-opt-recommendations').checked : true;
  const optBlocks = document.getElementById('copy-opt-blocks') ? document.getElementById('copy-opt-blocks').checked : true;
  const optOverwrite = document.getElementById('copy-opt-overwrite') ? document.getElementById('copy-opt-overwrite').checked : true;

  if (!optRecs && !optBlocks) {
    showModalAlert('No Transfer Options', 'Please check at least Recommended Slots or Course Blocks to transfer.', 'warning');
    return;
  }

  const cleanBase = (code) => String(code || '').replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
  const deptName = (state.currentUser && state.currentUser.departmentName) ? state.currentUser.departmentName.toUpperCase() : '';
  const deptCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === deptName);

  // Extract source structure
  const sourceCourses = deptCourses.filter(c => cleanBase(c.code) === sourceBase);
  const sourceSlots = {};
  sourceCourses.forEach(c => {
    const recs = localCurriculumCourseRecs[c.code] || {};
    Object.keys(recs).forEach(day => {
      Object.keys(recs[day]).forEach(p => {
        const val = recs[day][p];
        if ((val === 'T' || val === 'P') && !optRecs) return;
        if (val === 'B' && !optBlocks) return;
        if (!sourceSlots[day]) sourceSlots[day] = {};
        sourceSlots[day][p] = val;
      });
    });
  });

  // Apply to all selected target courses and their variants
  targetCodes.forEach(targetBase => {
    const targetCourses = deptCourses.filter(c => cleanBase(c.code) === targetBase);
    targetCourses.forEach(tc => {
      if (!localCurriculumCourseRecs[tc.code]) {
        localCurriculumCourseRecs[tc.code] = {};
      }

      if (optOverwrite) {
        if (optRecs && optBlocks) {
          localCurriculumCourseRecs[tc.code] = JSON.parse(JSON.stringify(sourceSlots));
        } else {
          // Clear only the selected types
          Object.keys(localCurriculumCourseRecs[tc.code]).forEach(day => {
            Object.keys(localCurriculumCourseRecs[tc.code][day]).forEach(p => {
              const val = localCurriculumCourseRecs[tc.code][day][p];
              if ((val === 'T' || val === 'P') && optRecs) delete localCurriculumCourseRecs[tc.code][day][p];
              if (val === 'B' && optBlocks) delete localCurriculumCourseRecs[tc.code][day][p];
            });
          });
          // Merge sourceSlots
          Object.keys(sourceSlots).forEach(day => {
            if (!localCurriculumCourseRecs[tc.code][day]) localCurriculumCourseRecs[tc.code][day] = {};
            Object.keys(sourceSlots[day]).forEach(p => {
              localCurriculumCourseRecs[tc.code][day][p] = sourceSlots[day][p];
            });
          });
        }
      } else {
        // Merge without overwriting
        Object.keys(sourceSlots).forEach(day => {
          if (!localCurriculumCourseRecs[tc.code][day]) localCurriculumCourseRecs[tc.code][day] = {};
          Object.keys(sourceSlots[day]).forEach(p => {
            if (!localCurriculumCourseRecs[tc.code][day][p]) {
              localCurriculumCourseRecs[tc.code][day][p] = sourceSlots[day][p];
            }
          });
        });
      }
    });
  });

  // Re-render matrices and breakdowns
  renderCurriculumSlotMatrix();
  renderCurriculumHoursBreakdown();

  // Close modal
  const modal = document.getElementById('modal-copy-curriculum-slots');
  if (modal) modal.classList.add('hidden');

  showModalAlert(
    'Structure Transferred Successfully',
    `Successfully transferred recommended slots & blocks from <strong>${escapeHtml(sourceBase)}</strong> to <strong>${targetCodes.length}</strong> course(s):<br>
     <div style="margin-top: 6px; font-size: 12px; color: var(--primary); font-weight: 600;">${targetCodes.join(', ')}</div>
     <div class="mt-2 text-xs text-muted">Click <strong>"Save Slot Allocations"</strong> when you are ready to persist these changes to the server.</div>`,
    'success'
  );
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

// =============================================================
// TAB 7: Cross-Department Teaching Controller & Interactive Handshake
// =============================================================

let crossDeptSelectedSlots = []; // array of { day: 'MONDAY', period: '2', type: 'T' | 'P' }
let activeCrossDeptSubtab = 'incoming';
let activeCrossSlotMode = 'T'; // 'T' or 'P'

function bindCrossDeptTeachingEvents() {
  // Sub-tab toggles (Incoming vs Outgoing)
  document.querySelectorAll('.cross-dept-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const subtab = btn.getAttribute('data-subtab');
      switchCrossDeptSubtab(subtab);
    });
  });

  // Refresh Button
  const btnRefresh = document.getElementById('btn-refresh-cross-dept');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      renderCrossDeptTeachingTab();
    });
  }

  // Open New Request Modal
  const btnOpenModal = document.getElementById('btn-open-new-cross-dept-request');
  if (btnOpenModal) {
    btnOpenModal.addEventListener('click', () => {
      openNewCrossDeptRequestModal();
    });
  }

  // Close New Request Modal
  const btnCloseModal = document.getElementById('btn-close-new-cross-dept-modal');
  const btnCancelModal = document.getElementById('btn-cancel-cross-req');
  [btnCloseModal, btnCancelModal].forEach(b => {
    if (b) {
      b.addEventListener('click', () => {
        const m = document.getElementById('modal-new-cross-dept-request');
        if (m) m.classList.add('hidden');
      });
    }
  });

  // Course search input filtering
  const courseSearchInput = document.getElementById('cross-req-course-search');
  if (courseSearchInput) {
    courseSearchInput.addEventListener('input', () => {
      filterCrossDeptCourses(courseSearchInput.value);
    });
  }

  // Course select in Request Modal -> sync hours and re-render slot picker
  const courseSelect = document.getElementById('cross-req-course');
  if (courseSelect) {
    courseSelect.addEventListener('change', () => {
      syncHoursFromSelectedCourse();
    });
  }

  // Category select change -> toggle individual TH/PR boxes
  const typeSelect = document.getElementById('cross-req-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      handleCrossDeptCategoryChange();
    });
  }

  // Theory / Practical hours inputs -> calculate total hours
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  [thInput, prInput].forEach(inp => {
    if (inp) {
      inp.addEventListener('input', () => {
        recalcCrossDeptTotalHours();
      });
    }
  });

  // Slot Mode buttons (Theory vs Practical)
  const btnModeT = document.getElementById('btn-cross-slot-mode-t');
  const btnModeP = document.getElementById('btn-cross-slot-mode-p');
  if (btnModeT && btnModeP) {
    btnModeT.addEventListener('click', () => {
      setCrossSlotMarkMode('T');
    });
    btnModeP.addEventListener('click', () => {
      setCrossSlotMarkMode('P');
    });
  }

  // Form submit for new cross-dept request
  const formNewReq = document.getElementById('form-new-cross-dept-request');
  if (formNewReq) {
    formNewReq.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitNewCrossDeptRequest();
    });
  }

  // Close Approve Modal
  const btnCloseApprove = document.getElementById('btn-close-approve-cross-dept-modal');
  const btnCancelApprove = document.getElementById('btn-cancel-approve-cross');
  [btnCloseApprove, btnCancelApprove].forEach(b => {
    if (b) {
      b.addEventListener('click', () => {
        const m = document.getElementById('modal-approve-cross-dept-request');
        if (m) m.classList.add('hidden');
      });
    }
  });

  // Reject Button in Approve Modal
  const btnReject = document.getElementById('btn-reject-cross-dept');
  if (btnReject) {
    btnReject.addEventListener('click', async () => {
      const reqId = document.getElementById('approve-cross-req-id')?.value;
      if (!reqId) return;
      const reason = prompt('Please enter the reason for rejecting this teaching request (optional):') || 'Rejected by department';
      await handleCrossDeptAction(reqId, 'REJECT', null, reason);
    });
  }

  // Form submit for Approve
  const formApprove = document.getElementById('form-approve-cross-dept');
  if (formApprove) {
    formApprove.addEventListener('submit', async (e) => {
      e.preventDefault();
      const reqId = document.getElementById('approve-cross-req-id')?.value;
      const facCode = document.getElementById('approve-cross-faculty-select')?.value;
      if (!reqId || !facCode) return;
      await handleCrossDeptAction(reqId, 'APPROVE', facCode, null);
    });
  }
}

function setCrossSlotMarkMode(mode) {
  activeCrossSlotMode = mode === 'P' ? 'P' : 'T';
  const btnModeT = document.getElementById('btn-cross-slot-mode-t');
  const btnModeP = document.getElementById('btn-cross-slot-mode-p');
  if (btnModeT && btnModeP) {
    if (activeCrossSlotMode === 'T') {
      btnModeT.style.background = '#fef3c7';
      btnModeT.style.color = '#b45309';
      btnModeT.style.border = '1.5px solid #d97706';
      btnModeT.style.fontWeight = '700';

      btnModeP.style.background = '#ffffff';
      btnModeP.style.color = '#475569';
      btnModeP.style.border = '1.5px solid var(--border)';
      btnModeP.style.fontWeight = '600';
    } else {
      btnModeP.style.background = '#d1fae5';
      btnModeP.style.color = '#065f46';
      btnModeP.style.border = '1.5px solid #059669';
      btnModeP.style.fontWeight = '700';

      btnModeT.style.background = '#ffffff';
      btnModeT.style.color = '#475569';
      btnModeT.style.border = '1.5px solid var(--border)';
      btnModeT.style.fontWeight = '600';
    }
  }
}

function filterCrossDeptCourses(searchQuery) {
  const courseSelect = document.getElementById('cross-req-course');
  if (!courseSelect) return;
  const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
  const myCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === myDept);
  const q = (searchQuery || '').trim().toLowerCase();

  const filtered = myCourses.filter(c => {
    if (!q) return true;
    const code = (c.code || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const alias = (c.alias || '').toLowerCase();
    return code.includes(q) || name.includes(q) || alias.includes(q);
  });

  courseSelect.innerHTML = '<option value="" disabled selected>Select Course from your Department</option>';
  filtered.forEach(c => {
    courseSelect.innerHTML += `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} - ${escapeHtml(c.name || c.code)} (Sem ${c.semester})</option>`;
  });

  if (filtered.length === 1) {
    courseSelect.value = filtered[0].code;
    syncHoursFromSelectedCourse();
  }
}

function syncHoursFromSelectedCourse() {
  const courseSelect = document.getElementById('cross-req-course');
  const typeSelect = document.getElementById('cross-req-type');
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  if (!courseSelect) return;

  const c = (state.courses || []).find(x => x.code === courseSelect.value);
  if (!c) return;

  const savedMap = (state.subjectTeacherMapping && state.currentUser && state.subjectTeacherMapping[state.currentUser.departmentName] && state.subjectTeacherMapping[state.currentUser.departmentName][c.code]) || {};

  let th = (savedMap.theoryHours !== undefined) ? parseInt(savedMap.theoryHours, 10) : (c.theoryHours !== undefined ? parseInt(c.theoryHours, 10) : null);
  let pr = (savedMap.practicalHours !== undefined) ? parseInt(savedMap.practicalHours, 10) : (c.practicalHours !== undefined ? parseInt(c.practicalHours, 10) : null);
  const totalH = parseInt(savedMap.hours || c.hours, 10) || 4;

  if (th === null && pr === null) {
    const isP = c.courseType === 'P' || c.code.endsWith('-P');
    if (isP) {
      pr = totalH >= 2 ? totalH - (totalH % 2) : 2;
      th = Math.max(0, totalH - pr);
    } else {
      th = totalH;
      pr = 0;
    }
  } else {
    if (th === null) th = Math.max(0, totalH - (pr || 0));
    if (pr === null) pr = Math.max(0, totalH - (th || 0));
  }

  if (thInput) thInput.value = th;
  if (prInput) prInput.value = pr;

  if (typeSelect) {
    if (pr > 0 && th > 0) typeSelect.value = 'BOTH';
    else if (pr > 0) typeSelect.value = 'P';
    else typeSelect.value = 'T';
  }

  handleCrossDeptCategoryChange();
}

function handleCrossDeptCategoryChange(keepSlots = false) {
  const typeSelect = document.getElementById('cross-req-type');
  const thBox = document.getElementById('cross-req-th-box');
  const prBox = document.getElementById('cross-req-pr-box');
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  const cat = typeSelect ? typeSelect.value : 'T';

  if (cat === 'T') {
    if (thBox) thBox.style.display = 'block';
    if (prBox) prBox.style.display = 'none';
    if (prInput) prInput.value = 0;
    if (thInput && parseInt(thInput.value, 10) <= 0) thInput.value = 2;
    setCrossSlotMarkMode('T');
  } else if (cat === 'P') {
    if (thBox) thBox.style.display = 'none';
    if (prBox) prBox.style.display = 'block';
    if (thInput) thInput.value = 0;
    if (prInput && parseInt(prInput.value, 10) <= 0) prInput.value = 2;
    setCrossSlotMarkMode('P');
  } else {
    // BOTH (Theory + Practical)
    if (thBox) thBox.style.display = 'block';
    if (prBox) prBox.style.display = 'block';
    if (thInput && parseInt(thInput.value, 10) <= 0) thInput.value = 2;
    if (prInput && parseInt(prInput.value, 10) <= 0) prInput.value = 2;
  }

  recalcCrossDeptTotalHours(keepSlots);
}

function recalcCrossDeptTotalHours(keepSlots = false) {
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  const hoursInput = document.getElementById('cross-req-hours');
  const totalDisplay = document.getElementById('cross-req-total-hours-display');

  const th = Math.max(0, parseInt(thInput?.value, 10) || 0);
  const pr = Math.max(0, parseInt(prInput?.value, 10) || 0);
  const total = th + pr;

  if (hoursInput) hoursInput.value = total;
  if (totalDisplay) totalDisplay.textContent = `${total} hrs`;

  if (!keepSlots) {
    crossDeptSelectedSlots = [];
  }
  updateCrossDeptSlotPickerCount();
  renderCrossDeptSlotPicker();
}

function acknowledgeApprovedCrossDeptRequests(myDept) {
  if (!myDept) return;
  const requests = state.crossDepartmentRequests || [];
  const approvedOutgoingIds = requests
    .filter(r => (r.requestingDept || '').toUpperCase() === myDept && r.status === 'APPROVED')
    .map(r => r.id);

  if (approvedOutgoingIds.length > 0) {
    try {
      const storageKey = `ack_approved_cross_reqs_${myDept}`;
      const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
      const combined = Array.from(new Set([...existing, ...approvedOutgoingIds]));
      localStorage.setItem(storageKey, JSON.stringify(combined));
    } catch (e) {
      console.warn('Could not persist acknowledged cross-dept requests:', e);
    }
  }
}

function updateAdvancedFeaturesNotificationBadge() {
  const mainBadge = document.getElementById('adv-features-notification-badge');
  const tabBadge = document.getElementById('adv-cross-dept-tab-badge');

  if (!state.currentUser || !state.currentUser.departmentName) {
    if (mainBadge) mainBadge.classList.add('hidden');
    if (tabBadge) tabBadge.classList.add('hidden');
    return;
  }

  const myDept = (state.currentUser.departmentName || '').toUpperCase();
  const requests = state.crossDepartmentRequests || [];

  // 1. Pending incoming requests that require this department's action/approval
  const pendingIncoming = requests.filter(r => (r.offeringDept || '').toUpperCase() === myDept && r.status === 'PENDING');

  // 2. Outgoing requests that have been APPROVED by the offering department and not yet acknowledged
  let acknowledgedIds = [];
  try {
    acknowledgedIds = JSON.parse(localStorage.getItem(`ack_approved_cross_reqs_${myDept}`) || '[]');
  } catch (e) {
    acknowledgedIds = [];
  }

  const unseenApproved = requests.filter(r => 
    (r.requestingDept || '').toUpperCase() === myDept && 
    r.status === 'APPROVED' && 
    !acknowledgedIds.includes(r.id)
  );

  const totalNotifications = pendingIncoming.length + unseenApproved.length;

  if (mainBadge) {
    if (totalNotifications > 0) {
      mainBadge.textContent = totalNotifications > 99 ? '99+' : totalNotifications;
      mainBadge.classList.remove('hidden');
      const tooltipParts = [];
      if (pendingIncoming.length > 0) tooltipParts.push(`${pendingIncoming.length} pending request(s) received`);
      if (unseenApproved.length > 0) tooltipParts.push(`${unseenApproved.length} approved request(s)`);
      mainBadge.title = tooltipParts.join(', ');
    } else {
      mainBadge.classList.add('hidden');
      mainBadge.title = 'Cross-Department Teaching Notifications';
    }
  }

  if (tabBadge) {
    if (totalNotifications > 0) {
      tabBadge.textContent = totalNotifications > 99 ? '99+' : totalNotifications;
      tabBadge.classList.remove('hidden');
    } else {
      tabBadge.classList.add('hidden');
    }
  }
}

function switchCrossDeptSubtab(subtab) {
  activeCrossDeptSubtab = subtab;
  const btnIn = document.getElementById('subtab-btn-incoming');
  const btnOut = document.getElementById('subtab-btn-outgoing');
  const secIn = document.getElementById('cross-dept-incoming-section');
  const secOut = document.getElementById('cross-dept-outgoing-section');

  if (subtab === 'incoming') {
    if (btnIn) { btnIn.className = 'btn btn-sm btn-primary cross-dept-subtab'; }
    if (btnOut) { btnOut.className = 'btn btn-sm btn-outline cross-dept-subtab'; }
    if (secIn) secIn.classList.remove('hidden');
    if (secOut) secOut.classList.add('hidden');
  } else {
    if (btnIn) { btnIn.className = 'btn btn-sm btn-outline cross-dept-subtab'; }
    if (btnOut) { btnOut.className = 'btn btn-sm btn-primary cross-dept-subtab'; }
    if (secIn) secIn.classList.add('hidden');
    if (secOut) secOut.classList.remove('hidden');

    const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
    acknowledgeApprovedCrossDeptRequests(myDept);
    updateAdvancedFeaturesNotificationBadge();
  }
}

async function renderCrossDeptTeachingTab() {
  try {
    const res = await authFetch('/api/cross-dept-requests');
    const data = await res.json();
    if (!data.success) {
      console.error('Failed to load cross-department requests:', data.message);
      return;
    }

    const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
    const requests = data.requests || [];
    state.crossDepartmentRequests = requests;

    const incoming = requests.filter(r => (r.offeringDept || '').toUpperCase() === myDept);
    const outgoing = requests.filter(r => (r.requestingDept || '').toUpperCase() === myDept);

    const countIn = document.getElementById('cross-dept-incoming-count');
    const countOut = document.getElementById('cross-dept-outgoing-count');
    if (countIn) countIn.textContent = incoming.length;
    if (countOut) countOut.textContent = outgoing.length;

    if (activeCrossDeptSubtab === 'outgoing') {
      acknowledgeApprovedCrossDeptRequests(myDept);
    }
    updateAdvancedFeaturesNotificationBadge();

    renderIncomingCrossDeptRequests(incoming);
    renderOutgoingCrossDeptRequests(outgoing);
  } catch (err) {
    console.error('Error fetching cross-department requests:', err);
  }
}

function renderIncomingCrossDeptRequests(requests) {
  const container = document.getElementById('cross-dept-incoming-list');
  if (!container) return;

  if (requests.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px; text-align: center; color: var(--text-muted); background: #f8fafc; border-radius: 8px; border: 1.5px dashed var(--border);">
        <i class="fa-solid fa-inbox" style="font-size: 28px; margin-bottom: 8px; color: #94a3b8;"></i>
        <p style="margin: 0; font-size: 13px;">No incoming teaching requests from other departments.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = requests.map(req => {
    const isPending = req.status === 'PENDING';
    const isApproved = req.status === 'APPROVED';
    const isRejected = req.status === 'REJECTED';

    let statusBadge = '';
    if (isPending) statusBadge = '<span class="badge" style="background: #fef3c7; color: #d97706; border: 1px solid #f59e0b;"><i class="fa-solid fa-clock"></i> Pending Review</span>';
    else if (isApproved) statusBadge = '<span class="badge" style="background: #d1fae5; color: #065f46; border: 1px solid #10b981;"><i class="fa-solid fa-check"></i> Approved</span>';
    else if (isRejected) statusBadge = '<span class="badge" style="background: #fee2e2; color: #991b1b; border: 1px solid #ef4444;"><i class="fa-solid fa-xmark"></i> Rejected</span>';

    const slotsDesc = (req.pinnedSlots || []).map(s => {
      const isPrac = s.type === 'P';
      const badgeStyle = isPrac ? 'background: #d1fae5; color: #065f46; border: 1px solid #059669;' : 'background: #fef3c7; color: #b45309; border: 1px solid #d97706;';
      return `<span class="badge" style="${badgeStyle} font-size: 10.5px; margin: 1px 2px;">${s.day.slice(0, 3)} P${s.period} (${isPrac ? 'PR' : 'TH'})</span>`;
    }).join(' ');

    const thH = req.theoryHours !== undefined ? req.theoryHours : (req.courseType === 'P' ? 0 : req.hours);
    const prH = req.practicalHours !== undefined ? req.practicalHours : (req.courseType === 'P' ? req.hours : 0);
    const hoursDesc = prH > 0 && thH > 0 ? `${req.hours} hrs (${thH} TH, ${prH} PR)` : `${req.hours} hrs (${req.courseType === 'P' ? 'Practical' : 'Theory'})`;

    return `
      <div class="card" style="padding: 14px 18px; border-radius: 8px; border: 1.5px solid var(--border); background: #ffffff;">
        <div class="flex-row justify-between items-start flex-wrap gap-2 mb-2">
          <div>
            <div class="flex-row items-center gap-2">
              <strong style="font-size: 14px; color: var(--text-main);">${escapeHtml(req.courseName)}</strong>
              <span class="badge badge-info" style="font-size: 11px;">${escapeHtml(req.courseCode)}</span>
              <span class="badge ${req.courseType === 'P' ? 'badge-success' : (req.courseType === 'BOTH' ? 'badge-info' : 'badge-warning')}" style="font-size: 10px;">${req.courseType === 'BOTH' ? 'Theory + Practical' : (req.courseType === 'P' ? 'Practical' : 'Theory')}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">
              Requested by <strong>Department of ${escapeHtml(req.requestingDept)}</strong> • Semester ${escapeHtml(req.semester)} • <strong>${hoursDesc}</strong>
            </div>
          </div>
          <div>${statusBadge}</div>
        </div>

        <div style="background: #f8fafc; border-radius: 6px; padding: 8px 12px; font-size: 12px; margin-bottom: 10px;">
          <i class="fa-solid fa-calendar-check text-warning" style="margin-right: 4px;"></i>
          <strong>Required Timetable Slots:</strong> <span style="font-weight: 600; color: var(--text-main);">${slotsDesc}</span>
        </div>

        ${isApproved ? `
          <div style="font-size: 12px; color: #065f46; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 6px 12px;">
            <i class="fa-solid fa-user-check"></i> Assigned Faculty: <strong>${escapeHtml(req.assignedFacultyName)} (${escapeHtml(req.assignedFacultyCode)})</strong>. This teacher's timetable now connects to this cross-department teaching!
          </div>
        ` : ''}

        ${isRejected ? `
          <div style="font-size: 12px; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 6px 12px;">
            <i class="fa-solid fa-circle-exclamation"></i> Rejection Reason: ${escapeHtml(req.rejectionReason || 'None')}
          </div>
        ` : ''}

        ${isPending ? `
          <div class="flex-row justify-end gap-2 mt-2 pt-2" style="border-top: 1px solid var(--border);">
            <button type="button" class="btn btn-primary btn-sm" onclick="openApproveCrossDeptModal('${req.id}')">
              <i class="fa-solid fa-user-check"></i> Assign Teacher & Approve
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderOutgoingCrossDeptRequests(requests) {
  const container = document.getElementById('cross-dept-outgoing-list');
  if (!container) return;

  if (requests.length === 0) {
    container.innerHTML = `
      <div style="padding: 30px; text-align: center; color: var(--text-muted); background: #f8fafc; border-radius: 8px; border: 1.5px dashed var(--border);">
        <i class="fa-solid fa-paper-plane" style="font-size: 28px; margin-bottom: 8px; color: #94a3b8;"></i>
        <p style="margin: 0; font-size: 13px;">No outgoing teaching requests sent yet.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = requests.map(req => {
    const isPending = req.status === 'PENDING';
    const isApproved = req.status === 'APPROVED';
    const isRejected = req.status === 'REJECTED';

    let statusBadge = '';
    if (isPending) statusBadge = '<span class="badge" style="background: #fef3c7; color: #d97706; border: 1px solid #f59e0b;"><i class="fa-solid fa-clock"></i> Awaiting Department Response</span>';
    else if (isApproved) statusBadge = '<span class="badge" style="background: #d1fae5; color: #065f46; border: 1px solid #10b981;"><i class="fa-solid fa-check"></i> Approved & Scheduled</span>';
    else if (isRejected) statusBadge = '<span class="badge" style="background: #fee2e2; color: #991b1b; border: 1px solid #ef4444;"><i class="fa-solid fa-xmark"></i> Rejected</span>';

    const slotsDesc = (req.pinnedSlots || []).map(s => {
      const isPrac = s.type === 'P';
      const badgeStyle = isPrac ? 'background: #d1fae5; color: #065f46; border: 1px solid #059669;' : 'background: #fef3c7; color: #b45309; border: 1px solid #d97706;';
      return `<span class="badge" style="${badgeStyle} font-size: 10.5px; margin: 1px 2px;">${s.day.slice(0, 3)} P${s.period} (${isPrac ? 'PR' : 'TH'})</span>`;
    }).join(' ');

    const thH = req.theoryHours !== undefined ? req.theoryHours : (req.courseType === 'P' ? 0 : req.hours);
    const prH = req.practicalHours !== undefined ? req.practicalHours : (req.courseType === 'P' ? req.hours : 0);
    const hoursDesc = prH > 0 && thH > 0 ? `${req.hours} hrs (${thH} TH, ${prH} PR)` : `${req.hours} hrs (${req.courseType === 'P' ? 'Practical' : 'Theory'})`;

    return `
      <div class="card" style="padding: 14px 18px; border-radius: 8px; border: 1.5px solid var(--border); background: #ffffff;">
        <div class="flex-row justify-between items-start flex-wrap gap-2 mb-2">
          <div>
            <div class="flex-row items-center gap-2">
              <strong style="font-size: 14px; color: var(--text-main);">${escapeHtml(req.courseName)}</strong>
              <span class="badge badge-info" style="font-size: 11px;">${escapeHtml(req.courseCode)}</span>
              <span class="badge ${req.courseType === 'P' ? 'badge-success' : (req.courseType === 'BOTH' ? 'badge-info' : 'badge-warning')}" style="font-size: 10px;">${req.courseType === 'BOTH' ? 'Theory + Practical' : (req.courseType === 'P' ? 'Practical' : 'Theory')}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">
              Target Offering Department: <strong>Department of ${escapeHtml(req.offeringDept)}</strong> • Semester ${escapeHtml(req.semester)} • <strong>${hoursDesc}</strong>
            </div>
          </div>
          <div>${statusBadge}</div>
        </div>

        <div style="background: #f8fafc; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
          <i class="fa-solid fa-calendar-check text-warning" style="margin-right: 4px;"></i>
          <strong>Pinned Compulsory Slots:</strong> <span style="font-weight: 600; color: var(--text-main);">${slotsDesc}</span>
        </div>

        ${isApproved ? `
          <div style="margin-top: 8px; font-size: 12px; color: #065f46; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 6px 12px;">
            <i class="fa-solid fa-circle-check"></i> Assigned Faculty: <strong>${escapeHtml(req.assignedFacultyName)} (${escapeHtml(req.assignedFacultyCode)})</strong> from Department of ${escapeHtml(req.offeringDept)}. This assignment is permanently placed into your course timetable!
          </div>
        ` : ''}

        ${isRejected ? `
          <div style="margin-top: 8px; font-size: 12px; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 6px 12px;">
            <i class="fa-solid fa-circle-exclamation"></i> Rejection Reason: ${escapeHtml(req.rejectionReason || 'Department unable to allocate faculty.')}
          </div>
        ` : ''}

        <div class="flex-row justify-end gap-2 mt-2 pt-2" style="border-top: 1px solid var(--border);">
          ${isPending ? `
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="openEditCrossDeptModal('${req.id}')" title="Edit this pending request">
              <i class="fa-solid fa-pen-to-square"></i> Edit Request
            </button>
          ` : ''}
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="deleteCrossDeptRequest('${req.id}', '${escapeHtml(req.courseCode)}', '${req.status}')">
            <i class="fa-solid fa-trash-can"></i> ${isApproved ? 'Delete Request & Clear Allocation' : 'Cancel Request'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openNewCrossDeptRequestModal() {
  const modal = document.getElementById('modal-new-cross-dept-request');
  const deptSelect = document.getElementById('cross-req-offering-dept');
  const courseSelect = document.getElementById('cross-req-course');
  const courseSearchInput = document.getElementById('cross-req-course-search');
  const feedback = document.getElementById('cross-req-feedback');
  const hiddenId = document.getElementById('cross-req-id');
  const titleEl = document.getElementById('modal-cross-dept-title');
  const btnSubmit = document.getElementById('btn-submit-cross-req');
  if (!modal) return;

  if (hiddenId) hiddenId.value = '';
  if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-paper-plane text-primary"></i> Request Faculty from Other Department';
  if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Teaching Request';
  if (feedback) { feedback.className = 'mb-2 hidden'; feedback.textContent = ''; }
  if (courseSearchInput) courseSearchInput.value = '';

  const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();

  // Populate offering departments (excluding own department)
  if (deptSelect) {
    deptSelect.innerHTML = '<option value="" disabled selected>Select Department (e.g. STATISTICS)</option>';
    const depts = (state.departments || []).filter(d => (d.name || d).toUpperCase() !== myDept);
    depts.forEach(d => {
      const dName = (d.name || d).toUpperCase();
      deptSelect.innerHTML += `<option value="${escapeHtml(dName)}">${escapeHtml(dName)}</option>`;
    });
  }

  // Populate own department courses
  if (courseSelect) {
    courseSelect.innerHTML = '<option value="" disabled selected>Select Course from your Department</option>';
    const myCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === myDept);
    myCourses.forEach(c => {
      courseSelect.innerHTML += `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} - ${escapeHtml(c.name || c.code)} (Sem ${c.semester})</option>`;
    });
  }

  setCrossSlotMarkMode('T');
  handleCrossDeptCategoryChange();
  modal.classList.remove('hidden');
}

function renderCrossDeptSlotPicker() {
  const container = document.getElementById('cross-req-slot-picker-grid');
  if (!container) return;

  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const periods = (state.config && state.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];

  let html = `<table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: center;">`;
  html += `<thead><tr><th style="padding: 4px; border: 1px solid var(--border); background: #e2e8f0;">Day</th>`;
  periods.forEach(p => {
    html += `<th style="padding: 4px; border: 1px solid var(--border); background: #e2e8f0;">${p === 'LB' ? 'LB' : `P${p}`}</th>`;
  });
  html += `</tr></thead><tbody>`;

  weekdays.forEach(day => {
    html += `<tr><td style="padding: 4px; border: 1px solid var(--border); font-weight: 700; background: #f1f5f9;">${day.slice(0, 3)}</td>`;
    periods.forEach(p => {
      if (p === 'LB') {
        html += `<td style="padding: 4px; border: 1px solid var(--border); color: #94a3b8; font-weight: 600;">LB</td>`;
        return;
      }
      const selSlot = crossDeptSelectedSlots.find(s => s.day === day && s.period === String(p));
      const isSelected = !!selSlot;

      let cellBg = '#ffffff';
      let cellBorder = '1px solid var(--border)';
      let icon = '<span style="color: #cbd5e1;">+</span>';

      if (isSelected) {
        if (selSlot.type === 'P') {
          cellBg = '#d1fae5';
          cellBorder = '2px solid #059669';
          icon = '<span class="legend-box recommend-p" style="display:inline-block; margin:0;">P</span>';
        } else {
          cellBg = '#fef3c7';
          cellBorder = '2px solid #d97706';
          icon = '<span class="legend-box recommend-t" style="display:inline-block; margin:0;">T</span>';
        }
      }

      html += `
        <td style="padding: 5px 3px; border: ${cellBorder}; background: ${cellBg}; cursor: pointer; user-select: none;"
            onclick="toggleCrossDeptSlotSelection('${day}', '${p}')">
          ${icon}
        </td>
      `;
    });
    html += `</tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

window.toggleCrossDeptSlotSelection = function(day, period) {
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  const thNeed = Math.max(0, parseInt(thInput?.value, 10) || 0);
  const prNeed = Math.max(0, parseInt(prInput?.value, 10) || 0);

  const idx = crossDeptSelectedSlots.findIndex(s => s.day === day && s.period === String(period));
  if (idx !== -1) {
    const existing = crossDeptSelectedSlots[idx];
    if (existing.type === activeCrossSlotMode) {
      crossDeptSelectedSlots.splice(idx, 1);
    } else {
      // Switching type from T to P or P to T: verify quota of new type
      const targetCount = crossDeptSelectedSlots.filter(s => s.type === activeCrossSlotMode).length;
      const targetNeed = activeCrossSlotMode === 'P' ? prNeed : thNeed;
      if (targetCount >= targetNeed) {
        showModalAlert('Quota Reached', `You have already selected all ${targetNeed} ${activeCrossSlotMode === 'P' ? 'Practical' : 'Theory'} hours.`, 'warning');
        return;
      }
      existing.type = activeCrossSlotMode;
    }
  } else {
    // Adding new slot: verify quota
    const curCount = crossDeptSelectedSlots.filter(s => s.type === activeCrossSlotMode).length;
    const curNeed = activeCrossSlotMode === 'P' ? prNeed : thNeed;
    if (curCount >= curNeed) {
      showModalAlert('Quota Reached', `You have already marked all ${curNeed} ${activeCrossSlotMode === 'P' ? 'Practical' : 'Theory'} hours. To mark more, increase the hours input or unmark another slot.`, 'warning');
      return;
    }
    crossDeptSelectedSlots.push({ day, period: String(period), type: activeCrossSlotMode });
  }

  updateCrossDeptSlotPickerCount();
  renderCrossDeptSlotPicker();
};

function updateCrossDeptSlotPickerCount() {
  const badge = document.getElementById('cross-req-pinned-count');
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  const hoursInput = document.getElementById('cross-req-hours');

  const thNeed = Math.max(0, parseInt(thInput?.value, 10) || 0);
  const prNeed = Math.max(0, parseInt(prInput?.value, 10) || 0);
  const totalNeed = thNeed + prNeed;

  const thCount = crossDeptSelectedSlots.filter(s => s.type === 'T').length;
  const prCount = crossDeptSelectedSlots.filter(s => s.type === 'P').length;
  const totalCount = crossDeptSelectedSlots.length;

  if (badge) {
    if (prNeed > 0 && thNeed > 0) {
      badge.textContent = `Selected: TH ${thCount}/${thNeed} | PR ${prCount}/${prNeed} (Total: ${totalCount}/${totalNeed} hrs)`;
    } else if (prNeed > 0) {
      badge.textContent = `Selected Practical: ${prCount} / ${prNeed} hrs`;
    } else {
      badge.textContent = `Selected Theory: ${thCount} / ${thNeed} hrs`;
    }

    if (thCount === thNeed && prCount === prNeed && totalCount === totalNeed && totalNeed > 0) {
      badge.className = 'badge badge-success';
    } else {
      badge.className = 'badge badge-warning';
    }
  }
}

async function submitNewCrossDeptRequest() {
  const reqId = document.getElementById('cross-req-id')?.value;
  const isEditing = Boolean(reqId);
  const offeringDept = document.getElementById('cross-req-offering-dept')?.value;
  const courseCode = document.getElementById('cross-req-course')?.value;
  const courseType = document.getElementById('cross-req-type')?.value;
  const thHours = parseInt(document.getElementById('cross-req-th-hours')?.value, 10) || 0;
  const prHours = parseInt(document.getElementById('cross-req-pr-hours')?.value, 10) || 0;
  const totalHours = thHours + prHours;
  const feedback = document.getElementById('cross-req-feedback');
  const btnSubmit = document.getElementById('btn-submit-cross-req');

  const courseObj = (state.courses || []).find(c => c.code === courseCode) || {};

  if (!offeringDept || !courseCode || totalHours <= 0) {
    if (feedback) {
      feedback.className = 'alert alert-danger mb-2';
      feedback.textContent = 'Please select the offering department, course, and enter valid hours.';
    }
    return;
  }

  const thCount = crossDeptSelectedSlots.filter(s => s.type === 'T').length;
  const prCount = crossDeptSelectedSlots.filter(s => s.type === 'P').length;

  if (thCount !== thHours || prCount !== prHours) {
    if (feedback) {
      feedback.className = 'alert alert-danger mb-2';
      feedback.textContent = `Slot mismatch: Please select exactly ${thHours} Theory slots (currently: ${thCount}) and ${prHours} Practical slots (currently: ${prCount}).`;
    }
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const url = isEditing ? `/api/cross-dept-requests/${reqId}/edit` : '/api/cross-dept-requests';
    const method = isEditing ? 'PUT' : 'POST';

    const res = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offeringDept,
        courseCode,
        courseName: courseObj.name || courseCode,
        semester: courseObj.semester || '1',
        courseType,
        hours: totalHours,
        theoryHours: thHours,
        practicalHours: prHours,
        pinnedSlots: crossDeptSelectedSlots
      })
    });

    const data = await res.json();
    if (data.success) {
      const modal = document.getElementById('modal-new-cross-dept-request');
      if (modal) modal.classList.add('hidden');
      showModalAlert(
        isEditing ? 'Request Updated' : 'Request Sent', 
        isEditing ? `Your teaching request for ${courseObj.name || courseCode} has been updated successfully.` : `Your teaching request for ${courseObj.name || courseCode} has been sent to the Department of ${offeringDept}.`, 
        'success'
      );
      switchCrossDeptSubtab('outgoing');
      await renderCrossDeptTeachingTab();
    } else {
      if (feedback) {
        feedback.className = 'alert alert-danger mb-2';
        feedback.textContent = data.message || 'Failed to submit request.';
      }
    }
  } catch (err) {
    console.error('Error submitting cross-dept request:', err);
    if (feedback) {
      feedback.className = 'alert alert-danger mb-2';
      feedback.textContent = 'Network or server error.';
    }
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = isEditing ? '<i class="fa-solid fa-floppy-disk"></i> Update Teaching Request' : '<i class="fa-solid fa-paper-plane"></i> Send Teaching Request';
    }
  }
}

window.openApproveCrossDeptModal = async function(reqId) {
  try {
    const res = await authFetch('/api/cross-dept-requests');
    const data = await res.json();
    const req = (data.requests || []).find(r => r.id === reqId);
    if (!req) return;

    const modal = document.getElementById('modal-approve-cross-dept-request');
    const detailsContainer = document.getElementById('approve-cross-dept-details');
    const facSelect = document.getElementById('approve-cross-faculty-select');
    const hiddenId = document.getElementById('approve-cross-req-id');
    const feedback = document.getElementById('approve-cross-feedback');

    if (hiddenId) hiddenId.value = req.id;
    if (feedback) { feedback.className = 'mb-2 hidden'; feedback.textContent = ''; }

    const slotsDesc = (req.pinnedSlots || []).map(s => {
      const isPrac = s.type === 'P';
      const badgeStyle = isPrac ? 'background: #d1fae5; color: #065f46; border: 1px solid #059669;' : 'background: #fef3c7; color: #b45309; border: 1px solid #d97706;';
      return `<span class="badge" style="${badgeStyle} font-size: 11px; margin: 1px 3px;">${s.day.slice(0, 3)} P${s.period} (${isPrac ? 'PR' : 'TH'})</span>`;
    }).join(' ');

    const thH = req.theoryHours !== undefined ? req.theoryHours : (req.courseType === 'P' ? 0 : req.hours);
    const prH = req.practicalHours !== undefined ? req.practicalHours : (req.courseType === 'P' ? req.hours : 0);
    const hoursDesc = prH > 0 && thH > 0 ? `${req.hours} hrs (${thH} TH, ${prH} PR)` : `${req.hours} hrs (${req.courseType === 'P' ? 'Practical' : 'Theory'})`;

    if (detailsContainer) {
      detailsContainer.innerHTML = `
        <div style="margin-bottom: 6px;">
          <strong>Requesting Department:</strong> Department of ${escapeHtml(req.requestingDept)}
        </div>
        <div style="margin-bottom: 6px;">
          <strong>Course to Teach:</strong> ${escapeHtml(req.courseName)} (${escapeHtml(req.courseCode)})
        </div>
        <div style="margin-bottom: 6px;">
          <strong>Teaching Type & Hours:</strong> ${hoursDesc}
        </div>
        <div>
          <strong>Required Timetable Slots:</strong> <div style="margin-top: 4px;">${slotsDesc}</div>
        </div>
      `;
    }

    // Populate faculty dropdown with own department faculty
    const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();
    if (facSelect) {
      facSelect.innerHTML = '<option value="" disabled selected>Select Teacher to Assign</option>';
      const myFaculty = (state.faculty || []).filter(f => (f.department || '').toUpperCase() === myDept);
      myFaculty.forEach(f => {
        facSelect.innerHTML += `<option value="${escapeHtml(f.code)}">${escapeHtml(f.name)} (${escapeHtml(f.code)})</option>`;
      });
    }

    if (modal) modal.classList.remove('hidden');
  } catch (err) {
    console.error('Error opening approve modal:', err);
  }
};

async function handleCrossDeptAction(reqId, action, facultyCode = null, rejectionReason = null) {
  const feedback = document.getElementById('approve-cross-feedback');
  const btnApprove = document.getElementById('btn-confirm-approve-cross');

  if (btnApprove) {
    btnApprove.disabled = true;
    btnApprove.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const res = await authFetch(`/api/cross-dept-requests/${reqId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, facultyCode, rejectionReason })
    });

    const data = await res.json();
    if (data.success) {
      const modal = document.getElementById('modal-approve-cross-dept-request');
      if (modal) modal.classList.add('hidden');
      showModalAlert(
        action === 'APPROVE' ? 'Approved & Scheduled' : 'Request Rejected', 
        data.message, 
        action === 'APPROVE' ? 'success' : 'info'
      );
      // Refresh global state so timetable and teacher schedule reflect newly auto-placed assignment
      await fetchGlobalData();
      await renderCrossDeptTeachingTab();
      renderAllocationMatrix();
      syncPrintViewsIfActive();
    } else {
      if (feedback) {
        feedback.className = 'alert alert-danger mb-2';
        feedback.textContent = data.message || 'Operation failed.';
      }
    }
  } catch (err) {
    console.error('Error handling cross-dept action:', err);
    if (feedback) {
      feedback.className = 'alert alert-danger mb-2';
      feedback.textContent = 'Network or server error.';
    }
  } finally {
    if (btnApprove) {
      btnApprove.disabled = false;
      btnApprove.innerHTML = '<i class="fa-solid fa-check"></i> Assign Teacher & Approve';
    }
  }
}

window.openEditCrossDeptModal = function(reqId) {
  const req = (state.crossDepartmentRequests || []).find(r => r.id === reqId);
  if (!req) {
    showModalAlert('Not Found', 'Request not found.', 'danger');
    return;
  }

  // Strictly enforce that only pending requests can be edited
  if (req.status !== 'PENDING') {
    showModalAlert('Cannot Edit', 'This request has already been reviewed/approved and cannot be edited.', 'warning');
    return;
  }

  const modal = document.getElementById('modal-new-cross-dept-request');
  const titleEl = document.getElementById('modal-cross-dept-title');
  const hiddenId = document.getElementById('cross-req-id');
  const btnSubmit = document.getElementById('btn-submit-cross-req');
  const deptSelect = document.getElementById('cross-req-offering-dept');
  const courseSelect = document.getElementById('cross-req-course');
  const typeSelect = document.getElementById('cross-req-type');
  const thInput = document.getElementById('cross-req-th-hours');
  const prInput = document.getElementById('cross-req-pr-hours');
  const hoursInput = document.getElementById('cross-req-hours');
  const totalDisplay = document.getElementById('cross-req-total-hours-display');
  const feedback = document.getElementById('cross-req-feedback');
  const courseSearchInput = document.getElementById('cross-req-course-search');

  if (!modal) return;
  if (feedback) { feedback.className = 'mb-2 hidden'; feedback.textContent = ''; }
  if (courseSearchInput) courseSearchInput.value = '';

  if (hiddenId) hiddenId.value = req.id;
  if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-pen-to-square text-primary"></i> Edit Cross-Department Request';
  if (btnSubmit) btnSubmit.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update Teaching Request';

  const myDept = (state.currentUser && state.currentUser.departmentName ? state.currentUser.departmentName : '').toUpperCase();

  // Populate offering departments (excluding own department)
  if (deptSelect) {
    deptSelect.innerHTML = '<option value="" disabled>Select Department (e.g. STATISTICS)</option>';
    const depts = (state.departments || []).filter(d => (d.name || d).toUpperCase() !== myDept);
    depts.forEach(d => {
      const dName = (d.name || d).toUpperCase();
      deptSelect.innerHTML += `<option value="${escapeHtml(dName)}">${escapeHtml(dName)}</option>`;
    });
    deptSelect.value = (req.offeringDept || '').toUpperCase();
  }

  // Populate own department courses
  if (courseSelect) {
    courseSelect.innerHTML = '<option value="" disabled>Select Course from your Department</option>';
    const myCourses = (state.courses || []).filter(c => (c.department || '').toUpperCase() === myDept);
    myCourses.forEach(c => {
      courseSelect.innerHTML += `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} - ${escapeHtml(c.name || c.code)} (Sem ${c.semester})</option>`;
    });
    courseSelect.value = req.courseCode;
  }

  const thH = req.theoryHours !== undefined ? req.theoryHours : (req.courseType === 'P' ? 0 : req.hours);
  const prH = req.practicalHours !== undefined ? req.practicalHours : (req.courseType === 'P' ? req.hours : 0);

  if (typeSelect) typeSelect.value = req.courseType || (prH > 0 && thH > 0 ? 'BOTH' : (prH > 0 ? 'P' : 'T'));
  if (thInput) thInput.value = thH;
  if (prInput) prInput.value = prH;
  if (hoursInput) hoursInput.value = req.hours;
  if (totalDisplay) totalDisplay.textContent = `${req.hours} hrs`;

  crossDeptSelectedSlots = (req.pinnedSlots || []).map(s => ({ ...s }));

  handleCrossDeptCategoryChange(true);
  setCrossSlotMarkMode(req.pinnedSlots && req.pinnedSlots[0] ? req.pinnedSlots[0].type : 'T');
  updateCrossDeptSlotPickerCount();
  renderCrossDeptSlotPicker();

  modal.classList.remove('hidden');
};

window.deleteCrossDeptRequest = function(reqId, courseCode, status) {
  const isApproved = status === 'APPROVED';
  const title = isApproved ? 'Delete Cross-Department Request?' : 'Cancel Cross-Department Request?';
  const desc = isApproved
    ? `Are you sure you want to delete this cross-department teaching request for ${courseCode}?\n\nThis will permanently remove the allocated teaching slots from your timetable, release the assigned teacher's schedule, and restore their availability in the offering department.`
    : `Are you sure you want to cancel this pending cross-department teaching request for ${courseCode}?`;

  showModalConfirm(title, desc, async () => {
    try {
      const res = await authFetch(`/api/cross-dept-requests/${reqId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        showModalAlert('Request Deleted', data.message, 'success');
        await fetchGlobalData();
        await renderCrossDeptTeachingTab();
        renderAllocationMatrix();
        updateDeptLiveWorkloadTracker();
        syncPrintViewsIfActive();
      } else {
        showModalAlert('Delete Failed', data.message || 'Failed to delete request.', 'danger');
      }
    } catch (err) {
      console.error('Error deleting cross-dept request:', err);
      showModalAlert('Error', 'Network or server error while deleting request.', 'danger');
    }
  });
};

// --------------------------------------------------------------------------
// Deployment Version Fetcher & Header / Footer Badge Population
// --------------------------------------------------------------------------
async function fetchVersionInfo() {
  try {
    const res = await fetch(`${API_BASE}/version`);
    if (res.ok) {
      const data = await res.json();
      const versionText = `v${data.version} (${data.commit})`;
      const fullText = `v${data.version} • commit ${data.commit} (${data.branch})`;

      const pill = document.getElementById('app-header-version-pill');
      if (pill) {
        pill.textContent = versionText;
        pill.title = `Branch: ${data.branch}\nCommit: ${data.commitFull || data.commit}\nDate: ${data.commitDate || ''}\nMessage: ${data.commitMessage || ''}`;
        pill.style.display = 'inline-block';
      }

      const loginText = document.getElementById('portal-version-text');
      if (loginText) {
        loginText.textContent = fullText;
        if (loginText.parentElement) {
          loginText.parentElement.title = `Commit Message: ${data.commitMessage || ''}\nDate: ${data.commitDate || ''}`;
        }
      }
    }
  } catch (err) {
    // Ignore quietly
  }
}








// Auto-flush draft save when user leaves or reloads
window.addEventListener('beforeunload', () => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (state.currentUser && state.currentUser.departmentName && state.allocations) {
      try {
        const payload = JSON.stringify({
          departmentName: state.currentUser.departmentName,
          allocations: state.allocations
        });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/allocations', blob);
      } catch (e) {}
    }
  }
});
