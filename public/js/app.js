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
  subjectTeacherMapping: {}
};

let autosaveTimer = null;

// Helper to format course code with clickable group badge
function formatCourseCodeWithGroup(code, group, mappedBatches = []) {
  const base = code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
  if (group && group > 0) {
    const titleText = mappedBatches && mappedBatches.length > 0
      ? `Mapped Batches:\n${mappedBatches.join('\n')}`
      : 'No batches mapped';
    return `${base} <span class="badge" title="${titleText}" style="background-color: hsl(256, 75%, 52%); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; cursor: help; border-radius: 4px;">G${group}</span>`;
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
  const keyWithGroup = course.code.replace(/-(T|P)$/, '').replace(/_C\d+$/, '');
  const keyWithoutGroup = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');

  if (classIndex) {
    const list = state.groupMappings[`${keyWithoutGroup}_C${classIndex}`] || state.groupMappings[`${keyWithGroup}_C${classIndex}`] || [];
    if (list.length > 0) return list;
  } else {
    let mapped = [];
    if (course.classes && course.classes > 1) {
      for (let i = 1; i <= course.classes; i++) {
        const list = state.groupMappings[`${keyWithoutGroup}_C${i}`] || state.groupMappings[`${keyWithGroup}_C${i}`] || [];
        if (list.length > 0) {
          mapped.push(`C${i}: ${list.join('/')}`);
        }
      }
    } else {
      mapped = state.groupMappings[keyWithGroup] || state.groupMappings[keyWithoutGroup] || [];
    }
    if (mapped.length > 0) {
      return mapped;
    }
  }

  // If this is a grouped course (elective), do not fallback to implicit department batch
  if (course.group && course.group > 0) {
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
    const [configRes, deptsRes, coursesRes, facultyRes, batchesRes, groupRes, unavailRes, mappingRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      authFetch(`${API_BASE}/courses`),
      authFetch(`${API_BASE}/faculty`),
      authFetch(`${API_BASE}/batches`),
      authFetch(`${API_BASE}/admin/group-mappings`),
      authFetch(`${API_BASE}/department/teacher-unavailability`),
      authFetch(`${API_BASE}/department/subject-mapping`)
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
  
  if (progSelect) {
    progSelect.addEventListener('change', () => {
      state.filters.program = progSelect.value;
      populateFilters();
      renderAllocationMatrix();
    });
  }
  
  semSelect.addEventListener('change', () => {
    state.filters.semester = semSelect.value;
    renderAllocationMatrix();
  });
  
  catSelect.addEventListener('change', () => {
    state.filters.category = catSelect.value;
    renderAllocationMatrix();
  });

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
    
    semSelect.innerHTML = '<option value="">All Semesters</option>';
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
    
    if (sems.includes(prevSelectedSem)) {
      semSelect.value = prevSelectedSem;
    } else {
      state.filters.semester = '';
      semSelect.value = '';
    }

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
      const targetLabel = activeSem ? `Semester ${activeSem}` : 'All Semesters';

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
              if (activeSem) {
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
    selectAvailTeacher.addEventListener('change', () => {
      activeUnavailTeacherCode = selectAvailTeacher.value;
      const allUnavail = state.teacherUnavailability || {};
      localTeacherUnavail = JSON.parse(JSON.stringify(allUnavail[activeUnavailTeacherCode] || []));
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
  
  // Filter courses for this department
  let deptCourses = state.courses.filter(c => c.department === deptName);
  
  // Apply Dropdown Filters
  if (state.filters.program) {
    deptCourses = deptCourses.filter(c => (c.programType || 'UG') === state.filters.program);
  }
  if (state.filters.semester) {
    deptCourses = deptCourses.filter(c => c.semester === state.filters.semester);
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
        const classBadgeTooltip = isCloned
          ? (rowBatchesWeek.length > 0 ? `Batch: ${rowBatchesWeek.join(', ')}` : 'No batch mapped')
          : '';
        const formattedCode = isCloned
          ? `${baseCode} <span class="badge" title="${classBadgeTooltip}" style="background-color: var(--primary); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px; cursor: help;">Class ${cl}</span>`
          : formatCourseCodeWithGroup(baseCode, group, rowBatchesWeek);
        const rowAlias = isCloned ? `${dispAlias} (C${cl})` : dispAlias;
        
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">${formattedCode}</td>
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
        const formattedCode = isCloned
          ? `${baseCode} <span class="badge" style="background-color: var(--primary); color: white; padding: 2px 6px; font-size: 11px; margin-left: 4px; border-radius: 4px;">Class ${cl}</span>`
          : formatCourseCodeWithGroup(baseCode, group, rowBatches);
        const rowAlias = isCloned ? `${dispAlias} (C${cl})` : dispAlias;
          
        const tr = document.createElement('tr');
        if (activeCourseRef.programType === 'PG') {
          tr.classList.add('row-pg');
        }
        tr.innerHTML = `
          <td style="text-align:left;">${formattedCode}</td>
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


// Renders the interactive contents of a grid cell
function renderCellSlot(baseCode, courseT, courseP, day, period, classIndex = null) {
  // Check if period is flagged by Admin for this course's semester
  const globalLocks = (state.config && state.config.globalLockedPeriods) || [];
  const courseSem = String((courseT && courseT.semester) || (courseP && courseP.semester) || '').replace(/^Sem(ester)?\s*/i, '').trim();
  const courseSemNum = parseInt(courseSem.replace(/\D+/g, ''), 10) || 0;
  const matchingLocks = globalLocks.filter(l => {
    if (l.day.toUpperCase() !== day.toUpperCase()) return false;
    if (String(l.period).trim() !== String(period).trim()) return false;
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    if (!lockSem || lockSem === 'all' || lockSem === '') return true;
    return lockSem === courseSem.toLowerCase();
  });
  // Prefer specific semester match over 'all'
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem.toLowerCase();
  }) || matchingLocks[0];

  const recT = (courseT && courseT.recommendations[day] && courseT.recommendations[day][period]) || '';
  const recP = (courseP && courseP.recommendations[day] && courseP.recommendations[day][period]) || '';
  
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

  if (isM) {
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
  if (globalLock) {
    classes += ' slot-admin-flagged';
  }

  const lockFlagBadge = globalLock ? `
    <div class="admin-lock-tag" title="Admin Flag: ${globalLock.label || 'Locked Period'}" style="font-size: 10px; font-weight: 700; color: #b45309; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
      <i class="fa-solid fa-lock" style="font-size: 9px;"></i> ${globalLock.label || 'Admin Flag'}
    </div>
  ` : '';
  
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
  const matchingLocks = globalLocks.filter(l => {
    if (l.day.toUpperCase() !== day.toUpperCase() || String(l.period).trim() !== String(period).trim()) return false;
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    if (!lockSem || lockSem === 'all' || lockSem === '') return true;
    return lockSem === courseSem;
  });
  const globalLock = matchingLocks.find(l => {
    const lockSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim().toLowerCase();
    return lockSem === courseSem;
  }) || matchingLocks[0];

  if (globalLock) {
    showModalConfirm(
      'Admin Flagged Period',
      `This period (${day} Period ${period}) is flagged institution-wide by Central Admin: "${globalLock.label || 'College Common Activity'}".\n\nDo you want to manually assign a faculty member to this slot?`,
      () => {
        openSelector();
      }
    );
    return;
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
  const course = state.courses.find(c => c.code === courseCode) || state.courses.find(c => c.code === baseCode) || state.courses.find(c => c.code === baseCodeForRec);
  const group = course ? course.group : 0;
  const mappedBatches = course ? course.mappedBatches : [];
  const formattedCode = formatCourseCodeWithGroup(baseCode, group, mappedBatches);
  
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
      const clashingGroupSuffix = (clashingCourse && clashingCourse.group > 0) ? ` (Group ${clashingCourse.group})` : '';
      showModalAlert(
        'Hard Booking Clash!', 
        `Double-booking violation!\n\nFaculty member '${conf.facultyName}' (${conf.facultyCode}) is already allocated to '${conf.clashingCourseName}' (${conf.clashingCourseCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '')}${clashingGroupSuffix}) on ${day} Period ${period} in department ${conf.department}.`,
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
    
    const baseCodeForRec = courseCode.replace(/-(T|P)$/, '').replace(/_C\d+/, '');
    const course = state.courses.find(c => c.code === courseCode) || state.courses.find(c => c.code === baseCodeForRec);
    const mData = localSubjectMappings[courseCode] || localSubjectMappings[baseCodeForRec] || {};
    const isPrac = (mData.courseType === 'P' || (course && course.courseType === 'P') || courseCode.endsWith('-P') || ((course && course.recommendations && course.recommendations[day] && course.recommendations[day][period]) === 'P'));

    // For practical slots: keep modal open so helpers can be assigned to the same period, with real-time update
    if (isPrac) {
      renderFacultySelectList();
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
      triggerAutosave();
    } else {
      // Close faculty selector modal for single-teacher theory slots
      document.getElementById('modal-faculty-select').classList.add('hidden');
      
      const recType = (course && course.recommendations && course.recommendations[day] && course.recommendations[day][period]) || '';
      if (recType === 'T' || recType === 'P') {
        showAutoFillPrompt(courseCode, recType, facultyCode);
      } else {
        renderAllocationMatrix();
        updateDeptLiveWorkloadTracker();
        activeSlotContext = null;
        triggerAutosave();
      }
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
            const cleanCode = course.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
            const groupText = course.group > 0 ? ` (Group ${course.group})` : '';
            const alias = (course.alias || course.code).replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
            missing.push(`${cleanCode}${groupText} alias '${alias}' requires allocation on ${day} Period ${p}`);
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
    const formattedCode = formatCourseCodeWithGroup(c.code, c.group, mappedBaseBatches);
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
          ${String(c.semester) === '5' ? `
            <button class="btn btn-outline btn-xs" style="padding: 2px 6px; font-size:10px; margin-left: auto;" onclick="openDeptBatchMappingModal('${c.code}')" ${locked ? 'disabled' : ''}>
              <i class="fa-solid fa-edit"></i> Map
            </button>
          ` : ''}
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
  const groupSuffix = course.group > 0 ? ` (G${course.group})` : (course.classNum ? ` (Class ${course.classNum})` : '');
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
    label.textContent = `Class ${i} Batch:`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control dept-group-select-item';
    input.setAttribute('list', 'dept-batch-datalist');
    input.placeholder = 'Type department or code...';
    input.dataset.groupIndex = i;

    // Load preselected batch dynamically matching C{i} or fallback to default
    let savedBatch = '';
    if (count > 1) {
      savedBatch = (state.groupMappings[`${cleanCode}_C${i}`] && state.groupMappings[`${cleanCode}_C${i}`][0]) || '';
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
// Advanced Features Suite Modal Controller
// ==========================================================================
let tempGeneratedAllocations = null;
let activeAdvancedFeaturesTab = 'adv-pane-teacher-unavail';
let localSubjectMappings = {};
let autoGenCourseFacultyBindings = {};
let autoGenCourseFacultyConfig = {};

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
    btnClose.addEventListener('click', closeAdvancedFeaturesModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeAdvancedFeaturesModal();
      }
    });
  }

  // Sidebar Tab Switching
  document.querySelectorAll('.adv-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const paneId = btn.getAttribute('data-pane');
      if (paneId) {
        switchAdvancedFeaturesTab(paneId);
      }
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
}

function openAdvancedFeaturesModal(initialPaneId = 'adv-pane-teacher-unavail') {
  if (isTimetableLocked()) {
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
  } else if (paneId === 'adv-pane-teacher-timetable') {
    renderTeacherTimetablesTab();
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
  semSelect.innerHTML = '<option value="">All Semesters in Department</option>';

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

  // Filter by Semester (supports simple sem '1' or combined '1_UG' / '1_PG')
  const targetSem = semSelect ? semSelect.value : '';
  if (targetSem) {
    if (targetSem.includes('_')) {
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
async function runAutoGeneration(forceRelaxed = false) {
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
    pinnedSlots = state.allocations || {};
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
  });

  renderAllocationMatrix();
  updateDeptLiveWorkloadTracker();
  await saveDepartmentAllocations(false);

  closeAdvancedFeaturesModal();
  showModalAlert('Schedule Applied', 'The auto-generated schedule has been applied to your timetable workspace and saved as draft!', 'success');
}




