let vue = new Vue({
    el: '#app',
    data: {
        msalInstance: null,
        isAuthenticated: false,
        user: {},
        logContent: null,
        logUrl: '', // Set to today's log file URL dynamically
        logDate: {
            day: String(new Date().getDate()).padStart(2, '0'), // default to today
            month: String(new Date().getMonth() + 1).padStart(2, '0'), // default to this month
            year: String(new Date().getFullYear()), // default to this year
        },
        showLogout: 0,
        isLoading: false,
        typesenseStatus: null,
        autoRefreshInterval: false,
        progress: null,
        viewType: {progress: true, logs: true},
        importStatus: null,
        fileNotFound: false,
    },
    methods: {
        login() {
            this.msalInstance.loginRedirect({ scopes: ['User.Read'] })
                .then(response => {
                    console.warn("login()")
                    this.handleLoginResponse(response);
                })
                .catch(error => {
                    console.error("Login failed", error);
                });
        },
        handleLoginResponse(response) {
            console.warn("handleLoginResponse")
            if (response && response.account) {
                // Set the active account for future token requests
                this.msalInstance.setActiveAccount(response.account);
                this.isAuthenticated = true;
                this.user = { name: response.account.name, email: response.account.username };
                this.fetchLog();
                this.checkTypesenseHealth();
                this.startAutoRefresh();
            } else {
                console.error("No account returned from login response");
            }
        },
        getTokenRequest(){
            return { scopes: ['https://management.azure.com/.default'],  account: this.msalInstance.getActiveAccount() };
        },
        fetchLog() {
            this.isLoading = true;
            if (!this.getTokenRequest().account) {
                console.error("No active account found. Make sure you're logged in.");
                return;
            }
            this.getLogUrl().then(latestLogUrl => {  // Dynamically build the log URL
                if (!latestLogUrl) {
                    this.fileNotFound = true;
                    this.logContent = null;
                    this.isLoading = false;
                    return;
                }
                this.msalInstance.acquireTokenSilent(this.getTokenRequest())
                    .then(tokenResponse => {
                        return fetch(latestLogUrl, {
                            headers: { 'Authorization': `Bearer ${tokenResponse.accessToken}` }
                        });
                    })
                    .then(response => {
                        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                        return response.text();
                    })
                    .then(data => {
                        this.logContent = data;
                        this.importStatus = null;
                        this.fileNotFound = false;
                        this.handleLogContent(this.logContent);
                    })
                    .catch(error => {
                        console.error("Error fetching log:", error);
                    })
                    .finally(() => this.isLoading = false);
            }).catch(error => {
                console.error("Error getting latest log URL:", error);
                this.isLoading = false;
            });
        },
        logout() {
            this.msalInstance.logout();
        },
        formatDate(timestamp) {
            const date = new Date(timestamp);
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');

            return `${day}.${month}. ${hours}:${minutes}:${seconds}`;
        },

        getLogUrl() {
            return this.msalInstance.acquireTokenSilent(this.getTokenRequest())
                .then(tokenResponse => {
                    return fetch('https://typesense-dataimport.scm.azurewebsites.net/api/vfs/LogFiles/', {
                        headers: { 'Authorization': `Bearer ${tokenResponse.accessToken}` }
                    });
                })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    return response.json();
                })
                .then(files => {
                    const selectedDateStr = `${this.logDate.year}_${this.logDate.month}_${this.logDate.day}`;
                    const logFiles = files .filter(file => file.name.endsWith('_default_docker.log')) .sort((a, b) => new Date(b.mtime) - new Date(a.mtime)); // Sort by last modified time
                    const selectedLog = logFiles.find(file => file.name.includes(selectedDateStr)); // Try to find a log file that matches the selected date
                    if (selectedLog) {
                        console.log("Using log file:", selectedLog.href);
                        return selectedLog.href;
                    } else if (logFiles.length > 0) { // Selected log not found
                        // console.warn("Selected log not found, using latest:", logFiles[0].href);
                        this.fileNotFound = true;
                        return null;
                    } else {
                        console.warn("No valid log files found.");
                        return null;
                    }
                })
                .catch(error => {
                    console.error("Error fetching log files:", error);
                    return null;
                });
        },

        checkTypesenseHealth() {
            // Fetch the health status from the Typesense API
            fetch('https://phc-api-typesense.azurewebsites.net/health')
                .then(response => response.json())
                .then(data => {
                    console.log("Typesense Health:", data);
                    if (data.ok) this.typesenseStatus = 'OK';
                    else this.typesenseStatus = 'DOWN';
                })
                .catch(error => {
                    console.error("Error checking Typesense health:", error);
                    this.typesenseStatus = 'DOWN'; // Default to DOWN if there is an error
                });
        },
        startAutoRefresh() {
            console.warn("startAutoRefresh")
            // Only start the auto-refresh if it's not already running
            if (!this.autoRefreshInterval) {
                this.autoRefreshInterval = setInterval(() => {
                    this.fetchLog();
                    this.checkTypesenseHealth();
                }, 5000); // Refresh every 5 seconds
            }
        },
        handleLogContent(data) {
            if (data.includes('not found')) { // Check if the log file was not found
                this.logContent = null;  // Clear the log content
                this.fileNotFound = true; // Set the flag
                return;
            }
            this.importStatus = 0;
            this.fileNotFound = false;
            this.initProgress();
            // Track individual collection import progress
            const collectionsInProgress = { ...this.progress };
            const lines = data.split("\n"); // Split log into lines
            // Find the last error index
            let lastErrorIndex = -1;
            const errorKeywords = ['error', 'failed', 'exception'];
            lines.forEach((line, index) => {
                if (errorKeywords.some(keyword => line.toLowerCase().includes(keyword))) {
                    lastErrorIndex = index; // Track the position of the last error
                    this.importStatus = -1; // Set import status to failed if an error is found
                }
            });
            if(lastErrorIndex !== -1) this.initProgress();
            // Slice the log to only process lines after the last error
            const linesAfterLastError = lastErrorIndex === -1 ? lines : lines.slice(lastErrorIndex + 1);
            // Reset progress for each collection if new import starts after an error
            let newImportStarted = false;
            // Process the log after the last error
            linesAfterLastError.forEach((line) => {
                // Set progress to 0% when a new import starts
                if (line.includes('DATA IMPORT - collection "organizations"')) {
                    this.progress.organizations = 0;
                    newImportStarted = true;
                }
                if (line.includes('DATA IMPORT - collection "roles"')) {
                    this.progress.roles = 0;
                    newImportStarted = true;
                }
                if (line.includes('DATA IMPORT - collection "inactive_roles"')) {
                    this.progress.inactive_roles = 0;
                    newImportStarted = true;
                }
                // Check for progress updates
                const progressMatch = line.match(/\|\s*(\d+)\s*\|\s*(\w+)\s*\|\s*([\d.]+)%\s*\|\s*(\d+)/);
                if (progressMatch) {
                    const collection = progressMatch[2]; // Get the collection name
                    const progressValue = parseFloat(progressMatch[3]); // Get progress percentage
                    if (this.progress[collection] !== undefined && this.progress[collection] !== -1) {
                        this.progress[collection] = progressValue; // Update the progress value
                    }
                }
                // Set progress to 100% when import is completed
                if (line.includes('DONE IMPORTING "organizations"')) this.progress.organizations = 100;
                if (line.includes('DONE IMPORTING "inactive_roles"')) this.progress.inactive_roles = 100;
                if (line.includes('DONE IMPORTING "roles"')) this.progress.roles = 100;
            });
            // If a new import has started after the error, set import status to in-progress (1)
            if (newImportStarted) {
                this.importStatus = 1; // Mark import as in-progress
            }
        },
        initProgress(){
            this.progress = { organizations: -1, inactive_roles: -1, roles: -1 };
        },
        prevDay() { // Move to the previous day
            let currentDate = new Date(`${this.logDate.year}-${this.logDate.month}-${this.logDate.day}`);
            currentDate.setDate(currentDate.getDate() - 1);  // Subtract one day
            this.updateLogDate(currentDate);  // Update the date and fetch the log
        },
        nextDay() { // Move to the next day
            let currentDate = new Date(`${this.logDate.year}-${this.logDate.month}-${this.logDate.day}`);
            currentDate.setDate(currentDate.getDate() + 1);  // Add one day
            this.updateLogDate(currentDate);  // Update the date and fetch the log
        },
        updateLogDate(newDate) { // Update logDate with the new date and fetch the log
            this.logDate = { day: String(newDate.getDate()).padStart(2, '0'), month: String(newDate.getMonth() + 1).padStart(2, '0'), year: String(newDate.getFullYear()) };
            this.fetchLog();  // Fetch the new log based on the updated date
        }
    },
    computed: {
        formattedLogEntries() {
            if (!this.logContent) return [];
            this.handleLogContent(this.logContent); // Update progress whenever logContent changes
            const entries = this.logContent.split("\n").map(line => {
                const timestampRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/;
                const match = line.match(timestampRegex);
                if (match) {
                    const rawTimestamp = match[0];
                    const formattedTimestamp = this.formatDate(rawTimestamp);
                    const data = line.replace(rawTimestamp, '').trim();
                    return { timestamp: formattedTimestamp, data: data };
                } else return { timestamp: '', data: line.trim() };
            });
            return entries;
        }
    },
    mounted() {
        this.msalInstance = new msal.PublicClientApplication({
            auth: {
                clientId: '0d3dfdb3-5044-45db-b46a-1c61ddd3b217',
                authority: 'https://login.microsoftonline.com/0c14b279-e578-4708-9453-effd46ade4ae',
                redirectUri: 'https://logdataimport.netlify.app/'
                // redirectUri: window.location.origin // Automatically use the current domain (local or live)
            },
            cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: true },
            system: {
                loggerOptions: {
                    loggerCallback: (level, message, containsPii) => {
                        if (level === msal.LogLevel.Error) console.error(message);
                        // else if (level === msal.LogLevel.Info) console.info(message);
                    },
                    piiLoggingEnabled: false,
                    logLevel: msal.LogLevel.Info
                }
            }
        });

        // Handle redirect response
        this.msalInstance.handleRedirectPromise().then(resp => {
            if (resp) this.handleLoginResponse(resp);
        });

        // Check if already logged in
        const accounts = this.msalInstance.getAllAccounts();
        if (accounts.length > 0) {
            this.isAuthenticated = true;
            this.user = { name: accounts[0].name, email: accounts[0].username };
            this.msalInstance.setActiveAccount(accounts[0]); // Set the active account
            this.initProgress();
            this.fetchLog(); // Fetch log if already logged in
            this.checkTypesenseHealth();
            this.startAutoRefresh();
        }
    }
});
Vue.config.devtools = true;
