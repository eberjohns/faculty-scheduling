// ==========================================================================
// Frontend JavaScript Controller & UI Orchestrator
// ==========================================================================

const API_BASE = '/api';

// Application State
let state = {
  currentUser: null, // { role: 'admin'|'department', departmentName?: string }
  config: null,      // { academicYear, semesterType, semesterLabels, periods }
  departments: [],   // list of department objects
  courses: [],       // list of courses
  faculty: [],       // list of faculty members
  allocations: {},   // active allocations for current department
  selectedDay: 'MONDAY',
  currentTab: 'tab-admin-dashboard'
};

// Cache DOM elements
const views = {
  login: document.getElementById('view-login'),
  admin: document.getElementById('view-admin'),
  department: document.getElementById('view-department')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  bindAuthEvents();
  bindSidebarEvents();
  bindAdminEvents();
  bindDeptEvents();
  bindPrintEvents();
  
  // Try to restore session from sessionStorage
  const savedUser = sessionStorage.getItem('currentUser');
  if (savedUser) {
    state.currentUser = JSON.parse(savedUser);
    document.getElementById('current-user-display').textContent = 
      state.currentUser.role === 'admin' ? 'Central Admin' : state.currentUser.departmentName;
    document.getElementById('header-user-info').classList.remove('hidden');
    
    await fetchGlobalData();
    if (state.currentUser.role === 'admin') {
      switchView('admin');
      showTab(state.currentTab);
    } else {
      switchView('department');
      await loadDepartmentWorkspace();
    }
  } else {
    // Populate departments list for login dropdown
    await loadLoginDepartments();
    switchView('login');
  }
}

// Switch between views (Login, Admin, Department)
function switchView(viewName) {
  Object.keys(views).forEach(name => {
    if (name === viewName) {
      views[name].classList.add('active');
      views[name].classList.remove('hidden');
    } else {
      views[name].classList.remove('active');
      views[name].classList.add('hidden');
    }
  });
}

// Fetch general configuration and list of departments
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
    console.error('Error loading login departments:', err);
  }
}

async function fetchGlobalData() {
  try {
    const [configRes, deptsRes, coursesRes, facultyRes] = await Promise.all([
      fetch(`${API_BASE}/config`),
      fetch(`${API_BASE}/departments`),
      fetch(`${API_BASE}/courses`),
      fetch(`${API_BASE}/faculty`)
    ]);
    
    state.config = await configRes.json();
    state.departments = await deptsRes.json();
    state.courses = await coursesRes.json();
    state.faculty = await facultyRes.json();
    
    updateAdminSummary();
  } catch (err) {
    console.error('Failed to load global data:', err);
  }
}

// -------------------------------------------------------------
// Authentication Binds & Logic
// -------------------------------------------------------------
function bindAuthEvents() {
  const roleSelect = document.getElementById('login-role');
  const deptGroup = document.getElementById('dept-select-group');
  const loginForm = document.getElementById('login-form');
  const logoutBtn = document.getElementById('btn-logout');
  const pwdIcon = document.getElementById('toggle-pwd-icon');
  const pwdInput = document.getElementById('login-password');
  
  roleSelect.addEventListener('change', () => {
    if (roleSelect.value === 'department') {
      deptGroup.classList.remove('hidden');
      document.getElementById('login-dept').setAttribute('required', 'true');
    } else {
      deptGroup.classList.add('hidden');
      document.getElementById('login-dept').removeAttribute('required');
    }
  });
  
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
    const role = roleSelect.value;
    const password = pwdInput.value;
    const departmentName = document.getElementById('login-dept').value;
    
    const errBox = document.getElementById('login-error');
    errBox.classList.add('hidden');
    
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, password, departmentName })
      });
      
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.message || 'Login failed');
      }
      
      state.currentUser = { role, departmentName };
      sessionStorage.setItem('currentUser', JSON.stringify(state.currentUser));
      
      document.getElementById('current-user-display').textContent = 
        role === 'admin' ? 'Central Admin' : departmentName;
      document.getElementById('header-user-info').classList.remove('hidden');
      
      await fetchGlobalData();
      
      if (role === 'admin') {
        switchView('admin');
        showTab('tab-admin-dashboard');
      } else {
        switchView('department');
        await loadDepartmentWorkspace();
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('currentUser');
    state.currentUser = null;
    document.getElementById('header-user-info').classList.add('hidden');
    pwdInput.value = '';
    loadLoginDepartments();
    switchView('login');
  });
}

// -------------------------------------------------------------
// Admin Navigation Tabs
// -------------------------------------------------------------
function bindSidebarEvents() {
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const tabId = item.getAttribute('data-tab');
      showTab(tabId);
    });
  });
}

function showTab(tabId) {
  state.currentTab = tabId;
  const panes = document.querySelectorAll('.dashboard-content .tab-pane');
  panes.forEach(pane => {
    if (pane.id === tabId) {
      pane.classList.remove('hidden');
      pane.classList.add('active');
    } else {
      pane.classList.add('hidden');
      pane.classList.remove('active');
    }
  });
  
  // Refresh specific tab data
  if (tabId === 'tab-admin-dashboard') {
    fetchGlobalData();
  } else if (tabId === 'tab-admin-config') {
    renderConfigForm();
  } else if (tabId === 'tab-admin-passwords') {
    renderPasswordTable();
  } else if (tabId === 'tab-admin-data') {
    renderDataManager();
  } else if (tabId === 'tab-admin-workload') {
    renderWorkloadSummary();
  }
}

// -------------------------------------------------------------
// Admin View Implementation
// -------------------------------------------------------------
function updateAdminSummary() {
  if (!state.config) return;
  document.getElementById('summary-year').textContent = state.config.academicYear || '-';
  document.getElementById('summary-sem').textContent = state.config.semesterType || '-';
  
  let approvedCount = 0;
  let submittedCount = 0;
  let incompleteCount = 0;
  
  state.departments.forEach(d => {
    if (d.status === 'Approved') approvedCount++;
    else if (d.status === 'Submitted') submittedCount++;
    else incompleteCount++;
  });
  
  document.getElementById('stat-approved').textContent = approvedCount;
  document.getElementById('stat-submitted').textContent = submittedCount;
  document.getElementById('stat-incomplete').textContent = incompleteCount;
  
  // Render departments table
  const tbody = document.querySelector('#table-admin-depts tbody');
  tbody.innerHTML = '';
  
  state.departments.forEach(d => {
    const tr = document.createElement('tr');
    
    let statusClass = 'recommend-none';
    if (d.status === 'Approved') statusClass = 'badge-info';
    else if (d.status === 'Submitted') statusClass = 'recommend-p';
    else if (d.status === 'Returned for Changes') statusClass = 'recommend-t';
    
    tr.innerHTML = `
      <td><strong>${d.name}</strong></td>
      <td><span class="badge ${statusClass}">${d.status}</span></td>
      <td>
        <span class="text-sm">
          ${d.hasPassword ? '<span class="text-success"><i class="fa-solid fa-lock"></i> Locked</span>' : '<span class="text-danger"><i class="fa-solid fa-unlock"></i> Unlocked</span>'}
        </span>
      </td>
      <td><span class="text-sm text-muted">${d.comments || 'No comments'}</span></td>
      <td>
        <div class="flex-row gap-2">
          <button class="btn btn-outline btn-xs" onclick="previewDeptTimetable('${d.name}')"><i class="fa-solid fa-eye"></i> View</button>
          ${d.status === 'Submitted' ? `
            <button class="btn btn-primary btn-xs" onclick="updateSubStatus('${d.name}', 'Approved')"><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn-outline btn-xs btn-danger" onclick="promptReturnDept('${d.name}')"><i class="fa-solid fa-rotate-left"></i> Return</button>
          ` : ''}
          ${d.status === 'Approved' ? `
            <button class="btn btn-outline btn-xs" onclick="updateSubStatus('${d.name}', 'Draft')"><i class="fa-solid fa-undo"></i> Revert to Draft</button>
          ` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Admin API Actions (Declared globally for onclick access)
window.previewDeptTimetable = async function(deptName) {
  await openTimetablePrintModal(deptName);
};

window.updateSubStatus = async function(deptName, status, comments = '') {
  try {
    const res = await fetch(`${API_BASE}/submissions/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentName: deptName, status, comments })
    });
    if (res.ok) {
      await fetchGlobalData();
    } else {
      const err = await res.json();
      alert('Error updating status: ' + err.message);
    }
  } catch (err) {
    console.error(err);
  }
};

window.promptReturnDept = function(deptName) {
  const comments = prompt(`Enter instructions/comments for returning ${deptName}'s timetable:`);
  if (comments !== null) {
    window.updateSubStatus(deptName, 'Returned for Changes', comments);
  }
};

function renderConfigForm() {
  document.getElementById('config-year').value = state.config.academicYear;
  document.getElementById('config-sem-type').value = state.config.semesterType;
  
  const container = document.getElementById('semester-labels-container');
  container.innerHTML = '';
  
  // Render mapping list for semesters
  Object.keys(state.config.semesterLabels).forEach(sem => {
    const div = document.createElement('div');
    div.className = 'form-group flex-row gap-2 mt-2';
    div.innerHTML = `
      <span class="badge badge-info" style="min-width: 60px;">Sem ${sem}</span>
      <i class="fa-solid fa-arrow-right text-muted"></i>
      <input type="text" class="form-control sem-mapping-input" data-sem="${sem}" value="${state.config.semesterLabels[sem]}" style="max-width: 200px;">
    `;
    container.appendChild(div);
  });
}

function renderPasswordTable() {
  const tbody = document.querySelector('#table-dept-passwords tbody');
  tbody.innerHTML = '';
  
  state.departments.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${d.name}</strong></td>
      <td>
        <input type="text" class="form-control dept-pwd-input" id="pwd-${d.name}" placeholder="Enter department password" style="max-width: 250px;">
      </td>
      <td>
        <button class="btn btn-primary" onclick="saveDeptPassword('${d.name}')"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.saveDeptPassword = async function(deptName) {
  const pwdInput = document.getElementById(`pwd-${deptName}`);
  const password = pwdInput.value.trim();
  if (!password) {
    alert('Please enter a valid password.');
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/departments/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: deptName, password })
    });
    if (res.ok) {
      alert(`Password updated successfully for ${deptName}.`);
      pwdInput.value = '';
      await fetchGlobalData();
    } else {
      const err = await res.json();
      alert('Error updating password: ' + err.message);
    }
  } catch (err) {
    console.error(err);
  }
};

function bindAdminEvents() {
  // Config form submit
  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const academicYear = document.getElementById('config-year').value;
    const semesterType = document.getElementById('config-sem-type').value;
    
    const semesterLabels = {};
    document.querySelectorAll('.sem-mapping-input').forEach(input => {
      const sem = input.getAttribute('data-sem');
      semesterLabels[sem] = input.value.trim();
    });
    
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ academicYear, semesterType, semesterLabels })
      });
      if (res.ok) {
        const successAlert = document.getElementById('config-success');
        successAlert.textContent = 'Settings saved successfully!';
        successAlert.classList.remove('hidden');
        setTimeout(() => successAlert.classList.add('hidden'), 3000);
        await fetchGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Excel trigger select
  document.querySelectorAll('.btn-file-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).click();
    });
  });

  // Import Course sheet
  document.getElementById('import-courses-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const status = document.getElementById('courses-upload-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Parsing Excel file...';
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const res = await fetch(`${API_BASE}/import/courses`, {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (res.ok) {
        status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> ${result.message}</span>`;
        await fetchGlobalData();
        renderImportReport(result.warnings || []);
      } else {
        status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${result.error}</span>`;
      }
    } catch (err) {
      status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Error uploading file</span>`;
    }
  });

  // Import Staff sheet
  document.getElementById('import-staff-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const status = document.getElementById('staff-upload-status');
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Parsing Excel file...';
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const res = await fetch(`${API_BASE}/import/staff`, {
        method: 'POST',
        body: formData
      });
      const result = await res.json();
      if (res.ok) {
        status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> ${result.message}</span>`;
        await fetchGlobalData();
        renderImportReport(result.warnings || []);
      } else {
        status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${result.error}</span>`;
      }
    } catch (err) {
      status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Error uploading file</span>`;
    }
  });

  // Data search filter
  document.getElementById('data-select-dept').addEventListener('change', () => {
    renderDataManager();
  });

  // Data management sub-tabs
  document.querySelectorAll('.tab-sub-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-sub-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const subId = btn.getAttribute('data-subtab');
      document.querySelectorAll('.subtab-pane').forEach(p => {
        if (p.id === subId) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
    });
  });
}

function renderImportReport(warnings) {
  const panel = document.getElementById('import-report-card');
  const list = document.getElementById('import-report-list');
  list.innerHTML = '';
  
  if (warnings.length > 0) {
    warnings.forEach(w => {
      const li = document.createElement('li');
      li.textContent = w;
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

// -------------------------------------------------------------
// Data Records Manager (Courses and Faculty Grid)
// -------------------------------------------------------------
function renderDataManager() {
  const selectedDept = document.getElementById('data-select-dept').value;
  
  // Populate dropdown once if empty
  const deptDropdown = document.getElementById('data-select-dept');
  if (deptDropdown.options.length <= 1) {
    const deptSet = new Set();
    state.courses.forEach(c => deptSet.add(c.department));
    state.faculty.forEach(f => deptSet.add(f.department));
    
    Array.from(deptSet).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      deptDropdown.appendChild(opt);
    });
  }

  // Filter lists
  let filteredCourses = state.courses;
  let filteredFaculty = state.faculty;
  if (selectedDept) {
    filteredCourses = filteredCourses.filter(c => c.department === selectedDept);
    filteredFaculty = filteredFaculty.filter(f => f.department === selectedDept);
  }

  document.getElementById('count-courses').textContent = filteredCourses.length;
  document.getElementById('count-faculty').textContent = filteredFaculty.length;

  // Render Courses
  const coursesTbody = document.querySelector('#table-manage-courses tbody');
  coursesTbody.innerHTML = '';
  filteredCourses.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.code}</strong></td>
      <td>${c.semester}</td>
      <td>${c.category}</td>
      <td>
        <input type="text" class="form-control text-sm" id="cname-${c.code}" value="${c.name}">
      </td>
      <td>
        <input type="text" class="form-control text-sm" id="calias-${c.code}" value="${c.alias || ''}">
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveCourseRecord('${c.code}')"><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    coursesTbody.appendChild(tr);
  });

  // Render Faculty
  const facultyTbody = document.querySelector('#table-manage-faculty tbody');
  facultyTbody.innerHTML = '';
  filteredFaculty.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${f.staffId}</td>
      <td><strong>${f.name}</strong></td>
      <td>${f.department}</td>
      <td>
        <input type="text" class="form-control text-sm" id="fcode-${f.staffId}" value="${f.code}" style="max-width: 100px;">
      </td>
      <td>
        <button class="btn btn-outline btn-xs" onclick="saveFacultyCode('${f.staffId}')"><i class="fa-solid fa-save"></i> Save</button>
      </td>
    `;
    facultyTbody.appendChild(tr);
  });
}

window.saveCourseRecord = async function(code) {
  const name = document.getElementById(`cname-${code}`).value.trim();
  const alias = document.getElementById(`calias-${code}`).value.trim();
  
  try {
    const res = await fetch(`${API_BASE}/courses/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, alias })
    });
    if (res.ok) {
      alert('Course details updated successfully!');
      await fetchGlobalData();
    }
  } catch (err) {
    console.error(err);
  }
};

window.saveFacultyCode = async function(staffId) {
  const code = document.getElementById(`fcode-${staffId}`).value.trim();
  
  try {
    const res = await fetch(`${API_BASE}/faculty/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, code })
    });
    if (res.ok) {
      alert('Faculty code updated successfully!');
      await fetchGlobalData();
      renderDataManager();
    } else {
      const err = await res.json();
      alert('Error updating code: ' + err.message);
    }
  } catch (err) {
    console.error(err);
  }
};

// -------------------------------------------------------------
// Workload Analytics Report
// -------------------------------------------------------------
async function renderWorkloadSummary() {
  try {
    const res = await fetch(`${API_BASE}/reports/workload`);
    const workloadData = await res.json();
    
    const tbody = document.querySelector('#table-workload-summary tbody');
    tbody.innerHTML = '';
    
    workloadData.forEach(row => {
      // Map courses to readable pills
      const courseKeys = Object.keys(row.workload);
      const coursesInfo = courseKeys.map(k => {
        const item = row.workload[k];
        return `<span class="badge badge-info" title="${k}">${k} (T:${item.theory}, P:${item.practical})</span>`;
      }).join(' ');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.staffId}</td>
        <td><strong>${row.name}</strong></td>
        <td><span class="fac-pill">${row.code}</span></td>
        <td>${row.department}</td>
        <td>${coursesInfo || '<span class="text-muted">None</span>'}</td>
        <td><strong class="text-primary">${row.totalHours} hrs</strong></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

// Export Workload summaries to CSV
document.getElementById('btn-export-workload-csv').addEventListener('click', () => {
  const table = document.getElementById('table-workload-summary');
  let csv = [];
  
  // Headers
  const ths = table.querySelectorAll('thead th');
  csv.push(Array.from(ths).map(th => `"${th.textContent}"`).join(','));
  
  // Rows
  const trs = table.querySelectorAll('tbody tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    const rowValues = Array.from(tds).map(td => {
      // Clean tags out of cells
      return `"${td.textContent.replace(/[\n\r]+/g, ' ').trim()}"`;
    });
    csv.push(rowValues.join(','));
  });
  
  const csvContent = "data:text/csv;charset=utf-8," + csv.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Faculty_Workload_Report_${state.config.academicYear}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// -------------------------------------------------------------
// Department Workspace View
// -------------------------------------------------------------
async function loadDepartmentWorkspace() {
  const deptName = state.currentUser.departmentName;
  document.getElementById('dept-title-name').textContent = `Department of ${deptName}`;
  
  // Fetch department allocations
  try {
    const res = await fetch(`${API_BASE}/allocations?department=${deptName}`);
    state.allocations = await res.json();
    
    // Refresh status badge
    updateDeptStatusBadge();
    
    // Render Day Matrix
    renderAllocationMatrix();
    
    // Render Workload live tracker
    updateDeptLiveWorkloadTracker();
  } catch (err) {
    console.error('Failed to load department workspace:', err);
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
  // Weekday tabs click listener
  document.querySelectorAll('.weekday-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.weekday-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.selectedDay = tab.getAttribute('data-day');
      renderAllocationMatrix();
    });
  });

  // Save Draft
  document.getElementById('btn-save-draft').addEventListener('click', async () => {
    await saveDepartmentAllocations(false);
  });

  // Submit timetable
  document.getElementById('btn-submit-timetable').addEventListener('click', async () => {
    await saveDepartmentAllocations(true);
  });

  // Preview Print Timetable
  document.getElementById('btn-preview-timetable').addEventListener('click', () => {
    openTimetablePrintModal(state.currentUser.departmentName);
  });
}

// Render Compact Day-Wise Allocation Grid
function renderAllocationMatrix() {
  const deptName = state.currentUser.departmentName;
  const day = state.selectedDay;
  const periods = state.config.periods;
  
  // Filter courses for this department
  const deptCourses = state.courses.filter(c => c.department === deptName);
  // Filter faculty for this department
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  
  const table = document.getElementById('table-allocation-matrix');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  // 1. Build Header
  let headerHtml = `
    <tr>
      <th style="min-width: 120px; text-align: left;">Course Code</th>
      <th style="min-width: 150px; text-align: left;">Alias / Course Name</th>
      <th style="width: 80px;">Sem.</th>
      <th style="width: 80px;">Category</th>
  `;
  periods.forEach(p => {
    headerHtml += `<th style="width: 120px;">${p}</th>`;
  });
  headerHtml += `</tr>`;
  thead.innerHTML = headerHtml;

  // 2. Build rows
  tbody.innerHTML = '';
  
  if (deptCourses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${periods.length + 4}" class="text-center text-muted">No courses loaded. Import structure Excel in Admin Panel first.</td></tr>`;
    return;
  }

  deptCourses.forEach(course => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align: left;"><strong>${course.code}</strong></td>
      <td style="text-align: left;"><span class="badge badge-info">${course.alias || course.code}</span> <span class="text-sm text-muted block">${course.name}</span></td>
      <td>${course.semester}</td>
      <td>${course.category}</td>
    `;
    
    // Add inputs for each period slot
    periods.forEach(p => {
      const td = document.createElement('td');
      
      // Check if this period represents a static Lunch Break
      if (p.toUpperCase() === 'LB') {
        td.className = 'slot-lb';
        td.textContent = 'LB';
        tr.appendChild(td);
        return;
      }

      // Check recommendation tags (T/P)
      const rec = (course.recommendations[day] && course.recommendations[day][p]) || '';
      let highlightClass = 'slot-recommend-none';
      let slotLabel = '';
      if (rec === 'T') {
        highlightClass = 'slot-recommend-t';
        slotLabel = 'Theory Rec';
      } else if (rec === 'P') {
        highlightClass = 'slot-recommend-p';
        slotLabel = 'Practical Rec';
      }
      
      // Determine if currently allocated
      const currentAssigned = (state.allocations[course.code] && state.allocations[course.code][day] && state.allocations[course.code][day][p]) || [];

      td.className = `slot-interactive ${highlightClass}`;
      
      // Dynamic rendering of dropdown choices and active tags
      let selectOptions = `<option value="">+ Assign</option>`;
      deptFaculty.forEach(f => {
        const isSelected = currentAssigned.includes(f.code) ? 'disabled' : '';
        selectOptions += `<option value="${f.code}" ${isSelected}>${f.code} - ${f.name}</option>`;
      });

      let assignedBadgesHtml = '';
      currentAssigned.forEach(facCode => {
        assignedBadgesHtml += `
          <span class="fac-pill">
            ${facCode}
            <i class="fa-solid fa-xmark" onclick="event.stopPropagation(); unassignFaculty('${course.code}', '${day}', '${p}', '${facCode}')"></i>
          </span>
        `;
      });

      td.innerHTML = `
        <div class="cell-slot" onclick="activateSlot(this)">
          <div class="cell-info text-sm bold text-muted">${slotLabel}</div>
          <div class="cell-select-wrapper hidden">
            <select class="slot-select" onchange="assignFaculty(this, '${course.code}', '${day}', '${p}')">
              ${selectOptions}
            </select>
          </div>
          <div class="cell-assigned-box">
            ${assignedBadgesHtml}
          </div>
        </div>
      `;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Slot click activator (reveals dropdown on selection)
window.activateSlot = function(container) {
  // Grey slots are disabled until explicit click confirmation
  const cell = container.closest('td');
  if (cell.classList.contains('slot-recommend-none')) {
    if (!cell.classList.contains('slot-active')) {
      const confirmEdit = confirm("This is a non-recommended timetable slot. Are you sure you want to assign faculty here?");
      if (!confirmEdit) return;
      cell.classList.add('slot-active');
    }
  }
  
  const selectWrapper = container.querySelector('.cell-select-wrapper');
  selectWrapper.classList.remove('hidden');
};

// Handle Faculty Assignment
window.assignFaculty = async function(selectEl, courseCode, day, period) {
  const facultyCode = selectEl.value;
  if (!facultyCode) return;
  
  const deptName = state.currentUser.departmentName;
  
  // 1. Get current assignments for this slot
  if (!state.allocations[courseCode]) state.allocations[courseCode] = {};
  if (!state.allocations[courseCode][day]) state.allocations[courseCode][day] = {};
  if (!state.allocations[courseCode][day][period]) state.allocations[courseCode][day][period] = [];
  
  const currentList = [...state.allocations[courseCode][day][period]];
  currentList.push(facultyCode);

  // 2. Validate clash against server
  try {
    const res = await fetch(`${API_BASE}/allocations/validate`, {
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
      // Clash detected! Play error actions
      const conf = validation.conflicts[0];
      alert(`[CLASH ERROR] Hard validation rule violation!\n\nFaculty member '${conf.facultyName}' (${conf.facultyCode}) is already allocated to course '${conf.clashingCourseName}' (${conf.clashingCourseCode}) on ${day} Period ${period} in department ${conf.department}.`);
      selectEl.value = '';
      return;
    }

    // No clash! Save locally
    state.allocations[courseCode][day][period] = currentList;
    
    // 3. Trigger Auto-fill behavior for recommendations
    const course = state.courses.find(c => c.code === courseCode);
    const recType = (course.recommendations[day] && course.recommendations[day][period]) || '';
    if (recType === 'T' || recType === 'P') {
      showAutoFillPrompt(courseCode, recType, facultyCode);
    } else {
      renderAllocationMatrix();
      updateDeptLiveWorkloadTracker();
    }
  } catch (err) {
    console.error(err);
  }
};

// Handle unassign faculty
window.unassignFaculty = function(courseCode, day, period, facultyCode) {
  if (state.allocations[courseCode] && state.allocations[courseCode][day] && state.allocations[courseCode][day][period]) {
    state.allocations[courseCode][day][period] = state.allocations[courseCode][day][period].filter(code => code !== facultyCode);
    renderAllocationMatrix();
    updateDeptLiveWorkloadTracker();
  }
};

// Auto-fill confirmation dialog
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
    const course = state.courses.find(c => c.code === courseCode);
    
    // Check all weekdays and periods for recommended type slots
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    weekdays.forEach(d => {
      const recs = course.recommendations[d] || {};
      Object.keys(recs).forEach(p => {
        if (recs[p] === type) {
          // Verify no clash exists before auto-filling
          const hasClash = checkLocalClash(facultyCode, d, p, courseCode);
          if (!hasClash) {
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
}

// Local clash check before applying autofills
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

// Department Live workload counter
function updateDeptLiveWorkloadTracker() {
  const deptName = state.currentUser.departmentName;
  const deptFaculty = state.faculty.filter(f => f.department === deptName);
  
  const container = document.getElementById('dept-live-workload');
  container.innerHTML = '';

  deptFaculty.forEach(f => {
    // Calculate total hours allocated to this faculty
    let hours = 0;
    Object.keys(state.allocations).forEach(courseCode => {
      const days = state.allocations[courseCode];
      Object.keys(days).forEach(day => {
        Object.keys(days[day]).forEach(p => {
          if (days[day][p] && days[day][p].includes(f.code)) {
            hours++;
          }
        });
      });
    });

    const pill = document.createElement('div');
    pill.className = 'workload-pill';
    pill.innerHTML = `
      <span class="fac-code">${f.code}</span>
      <span class="fac-hours">${hours} hrs</span>
    `;
    container.appendChild(pill);
  });
}

// Save or submit database updates
async function saveDepartmentAllocations(isSubmission = false) {
  const deptName = state.currentUser.departmentName;
  
  // 1. Dry run submit check
  if (isSubmission) {
    // Find missing recommendations warning
    const missing = [];
    const deptCourses = state.courses.filter(c => c.department === deptName);
    
    deptCourses.forEach(course => {
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
      weekdays.forEach(day => {
        const recs = course.recommendations[day] || {};
        Object.keys(recs).forEach(p => {
          const alloc = (state.allocations[course.code] && state.allocations[course.code][day] && state.allocations[course.code][day][p]) || [];
          if (alloc.length === 0) {
            missing.push(`${course.code} alias '${course.alias}' requires allocation on ${day} Period ${p}`);
          }
        });
      });
    });

    if (missing.length > 0) {
      const proceed = confirm(`[SUBMIT WARNING] Some recommended slots are missing allocations:\n\n${missing.slice(0,5).join('\n')}\n${missing.length > 5 ? '... and ' + (missing.length - 5) + ' more' : ''}\n\nDo you still want to proceed with submission?`);
      if (!proceed) return;
    }
  }

  // 2. Save allocations to backend
  try {
    const saveRes = await fetch(`${API_BASE}/allocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        departmentName: deptName,
        allocations: state.allocations
      })
    });
    const result = await saveRes.json();
    
    if (!saveRes.ok) {
      alert('Failed to save allocation data: ' + result.message);
      return;
    }

    // 3. Update submission status if submitting
    if (isSubmission) {
      const subRes = await fetch(`${API_BASE}/submissions/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          departmentName: deptName,
          status: 'Submitted',
          comments: 'Timetable submitted by coordinator.'
        })
      });
      if (subRes.ok) {
        alert('Timetable submitted successfully!');
        await loadDepartmentWorkspace();
      }
    } else {
      alert('Draft saved successfully!');
    }
  } catch (err) {
    console.error(err);
  }
}

// -------------------------------------------------------------
// Timetable Print Center (Dynamic Layout Builder)
// -------------------------------------------------------------
function bindPrintEvents() {
  document.getElementById('btn-close-print-modal').addEventListener('click', () => {
    document.getElementById('modal-print-preview').classList.add('hidden');
  });
  
  document.getElementById('print-mode-select').addEventListener('change', () => {
    // Re-render based on selected mode
    buildPrintTimetableHtml(document.getElementById('print-mode-select').value);
  });
  
  document.getElementById('btn-trigger-print').addEventListener('click', () => {
    window.print();
  });
  
  document.getElementById('btn-export-timetable-csv').addEventListener('click', () => {
    exportPrintTimetableToCSV();
  });
}

let activePrintDept = "";

async function openTimetablePrintModal(deptName) {
  activePrintDept = deptName;
  document.getElementById('print-dept-name').textContent = `DEPARTMENT OF ${deptName}`;
  document.getElementById('print-active-sem').textContent = `${state.config.semesterType} SEMESTER`;
  document.getElementById('print-active-year').textContent = state.config.academicYear;
  
  // Build Grid HTML
  buildPrintTimetableHtml('medium');
  
  document.getElementById('modal-print-preview').classList.remove('hidden');
}

// Parallel Rows Grid Algorithm (groups by category, places parallel courses on sub-rows)
function buildPrintTimetableHtml(displayMode) {
  const periods = state.config.periods;
  const table = document.getElementById('print-grid-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  
  // 1. Build Header
  let headerHtml = `
    <tr>
      <th style="width: 80px;">Day</th>
      <th style="width: 100px; text-align: left;">Class/Semester</th>
  `;
  periods.forEach(p => {
    headerHtml += `<th>${p}</th>`;
  });
  headerHtml += `</tr>`;
  thead.innerHTML = headerHtml;

  // Fetch all courses and allocations of department
  const deptCourses = state.courses.filter(c => c.department === activePrintDept);
  
  // We need to fetch allocations for this department
  // If the active user is not this department, fetch it asynchronously
  let deptAllocations = state.allocations;
  if (state.currentUser.role === 'admin' || state.currentUser.departmentName !== activePrintDept) {
    // In admin mode or previewing other departments
    deptAllocations = {};
    // Load allocations from global fetch or server
    fetchAllocationsForPrint(displayMode);
    return;
  }
  
  renderPrintGridRows(deptCourses, deptAllocations, periods, displayMode, tbody);
}

async function fetchAllocationsForPrint(displayMode) {
  try {
    const res = await fetch(`${API_BASE}/allocations?department=${activePrintDept}`);
    const allocs = await res.json();
    const deptCourses = state.courses.filter(c => c.department === activePrintDept);
    const periods = state.config.periods;
    const tbody = document.querySelector('#print-grid-table tbody');
    renderPrintGridRows(deptCourses, allocs, periods, displayMode, tbody);
  } catch (err) {
    console.error(err);
  }
}

// Maps course semester label and category to output row categories
function getTimetableRowCategory(course) {
  const semLabel = state.config.semesterLabels[course.semester] || `${course.semester} Sem`;
  
  // If course contains MSC/M.Sc (case-insensitive) in course code or pathway
  if (course.code.toUpperCase().includes('MSC') || course.pathway.toUpperCase().includes('MSC') || course.pathway.toUpperCase().includes('POST GRADUATE')) {
    return semLabel + " MSC";
  }

  // If course is minor
  if (course.category.toUpperCase().includes('MINOR')) {
    return semLabel + " MINOR";
  }
  
  // Default to semLabel + BSC
  return semLabel + " BSC";
}

function renderPrintGridRows(courses, allocations, periods, displayMode, tbody) {
  tbody.innerHTML = '';
  
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const weekdayShort = { "MONDAY": "MON", "TUESDAY": "TUES", "WEDNESDAY": "WED", "THURSDAY": "THUR", "FRIDAY": "FRI" };

  weekdays.forEach(day => {
    // 1. Group courses by row category for this day
    const categoriesMap = {};
    courses.forEach(c => {
      const cat = getTimetableRowCategory(c);
      if (!categoriesMap[cat]) categoriesMap[cat] = [];
      categoriesMap[cat].push(c);
    });

    // We sort categories so major BSC classes are first, MSC second, Minors third
    const categories = Object.keys(categoriesMap).sort((a, b) => {
      // Sort priority: MSC first, BSC second, MINOR third
      const getPriority = (x) => {
        if (x.includes("MSC")) return 1;
        if (x.includes("BSC")) return 2;
        if (x.includes("MINOR")) return 3;
        return 4;
      };
      return getPriority(a) - getPriority(b) || a.localeCompare(b);
    });

    // Calculate total rows needed for this weekday to set the day merged column rowspan
    let weekdayTotalRows = 0;
    const categoryLayouts = {}; // Maps category -> list of sub-rows (each sub-row is a map of period -> courseAllocText)

    categories.forEach(cat => {
      const catCourses = categoriesMap[cat];
      
      // We perform interval scheduling (bin packing) to arrange parallel courses in minimum sub-rows
      const subRows = []; // Array of sub-row grids: each grid is a map of period -> courseAllocationText

      catCourses.forEach(course => {
        // Collect periods where this course has allocation
        const coursePeriods = [];
        periods.forEach(p => {
          if (p.toUpperCase() === 'LB') return;
          const assigned = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][p]) || [];
          if (assigned.length > 0) {
            coursePeriods.push(p);
          }
        });

        if (coursePeriods.length === 0) return; // No allocation on this day, skip course

        // Find the first sub-row where there are no period clashes
        let placed = false;
        for (let r = 0; r < subRows.length; r++) {
          const hasClash = coursePeriods.some(p => !!subRows[r][p]);
          if (!hasClash) {
            // Place in this sub-row
            coursePeriods.forEach(p => {
              subRows[r][p] = formatAllocationCell(course, day, p, allocations, displayMode);
            });
            placed = true;
            break;
          }
        }

        if (!placed) {
          // Create new sub-row
          const newRow = {};
          coursePeriods.forEach(p => {
            newRow[p] = formatAllocationCell(course, day, p, allocations, displayMode);
          });
          subRows.push(newRow);
        }
      });

      // If category has no allocations at all, we render a single empty row for it
      if (subRows.length === 0) {
        subRows.push({});
      }

      categoryLayouts[cat] = subRows;
      weekdayTotalRows += subRows.length;
    });

    // 2. Render HTML rows
    categories.forEach((cat, catIdx) => {
      const subRows = categoryLayouts[cat];
      
      subRows.forEach((srow, sidx) => {
        const tr = document.createElement('tr');
        
        // Merge Day column for first row of the weekday
        if (catIdx === 0 && sidx === 0) {
          const tdDay = document.createElement('td');
          tdDay.rowSpan = weekdayTotalRows;
          tdDay.className = 'day-cell';
          tdDay.textContent = weekdayShort[day];
          tr.appendChild(tdDay);
        }

        // Merge Class/Semester column for first row of the category
        if (sidx === 0) {
          const tdClass = document.createElement('td');
          tdClass.rowSpan = subRows.length;
          tdClass.className = 'class-cell';
          tdClass.textContent = cat;
          tr.appendChild(tdClass);
        }

        // Add period cells
        periods.forEach(p => {
          const td = document.createElement('td');
          
          if (p.toUpperCase() === 'LB') {
            td.className = 'break-cell';
            td.textContent = 'LB';
            tr.appendChild(td);
            return;
          }

          td.innerHTML = srow[p] || ''; // Insert formatted allocation text
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
    });
  });
}

// Cell print text formatter based on mode selections
function formatAllocationCell(course, day, period, allocations, mode) {
  const assignedCodes = (allocations[course.code] && allocations[course.code][day] && allocations[course.code][day][period]) || [];
  if (assignedCodes.length === 0) return '';

  const alias = course.alias || course.code;
  const isPractical = (course.recommendations[day] && course.recommendations[day][period]) === 'P';
  const suffix = isPractical ? ' PR' : '';

  if (mode === 'short') {
    // E.g. SJ OOPS or JP/SS OOPS PR
    const facs = assignedCodes.join('/');
    return `${facs} ${alias}${suffix}`;
  } else if (mode === 'medium') {
    // E.g. SJ - OOPS or JP/SS - OOPS PR
    const facs = assignedCodes.join('/');
    return `${facs} - ${alias}${suffix}`;
  } else {
    // Full mode: Susan Joseph <br> Object Oriented Programming
    const facNames = assignedCodes.map(code => {
      const facObj = state.faculty.find(f => f.code === code);
      return facObj ? facObj.name : code;
    }).join(' / ');
    return `<div class="bold">${facNames}</div><div class="text-sm">${course.name}${suffix}</div>`;
  }
}

// Export Print Timetable to CSV
function exportPrintTimetableToCSV() {
  const table = document.getElementById('print-grid-table');
  let csv = [];
  
  // Headers
  const ths = table.querySelectorAll('thead th');
  csv.push(Array.from(ths).map(th => `"${th.textContent}"`).join(','));
  
  // Rows
  const trs = table.querySelectorAll('tbody tr');
  let currentDay = '';
  
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    let tdValues = Array.from(tds).map(td => td.textContent.replace(/[\n\r]+/g, ' ').trim());
    
    // Check if the first cell is day, if so, cache it
    if (tds[0] && tds[0].className === 'day-cell') {
      currentDay = tdValues[0];
    } else {
      // If it doesn't have the day cell, prepend cached day value
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
