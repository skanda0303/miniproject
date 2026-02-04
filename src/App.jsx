import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [status, setStatus] = useState({ authenticated: false, fileCount: 0, logs: [] });
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);

  const [suggestions, setSuggestions] = useState([]);
  const [files, setFiles] = useState([]);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/status');
        const data = await res.json();
        setStatus(data);

        const sugRes = await fetch('http://localhost:3001/api/suggestions');
        const sugData = await sugRes.json();
        setSuggestions(sugData);

        const filesRes = await fetch('http://localhost:3001/api/files');
        const filesData = await filesRes.json();
        setFiles(filesData);
      } catch (e) {
        console.error('Failed to fetch status');
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (id) => {
    await fetch('http://localhost:3001/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    setSuggestions(suggestions.filter(s => s.id !== id));
  };

  const handleConnect = async () => {
    const res = await fetch('http://localhost:3001/auth/url');
    const data = await res.json();
    window.open(data.url, '_blank');
  };

  const handleAsk = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      const data = await res.json();
      setAnswer(data.answer);
    } catch (e) {
      setAnswer('Failed to get answer');
    }
    setLoading(false);
  };

  const handleRescan = async () => {
    try {
      await fetch('http://localhost:3001/api/scan', { method: 'POST' });
      // Optionally refresh status immediately
    } catch (e) {
      console.error('Failed to trigger scan');
    }
  };

  return (
    <div className="container">
      <header>
        <h1 className="gradient-text">Drive Intelligence Agent</h1>
        <div className={`status-badge ${status.authenticated ? 'status-active' : 'status-inactive'}`}>
          <div className="status-dot"></div>
          {status.authenticated ? 'Agent Active' : 'Disconnected'}
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="glass-card stats-card">
          <h3>Memory Stats</h3>
          <div className="stat-item">
            <span className="label">Analyzed Files</span>
            <span className="value">{status.fileCount}</span>
          </div>
          {!status.authenticated && (
            <button onClick={handleConnect} className="connect-btn">Connect Google Drive</button>
          )}
        </section>

        <section className="glass-card logs-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0 }}>Activity Logs</h3>
            <button onClick={handleRescan} className="rescan-btn" style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '0.4rem 0.8rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}>
              ↻ Rescan
            </button>
          </div>
          <div className="logs-list">
            {status.logs.map(log => (
              <div key={log.id} className="log-entry">
                <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span className="log-action">{log.action}</span>
                <span className="log-details">{log.details}</span>
              </div>
            ))}
            {status.logs.length === 0 && <p className="empty-state">No activity yet</p>}
          </div>
        </section>

        <section className="glass-card chat-card">
          <h3>Ask Your Drive</h3>
          <form onSubmit={handleAsk} className="chat-form">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="How can I help you today?"
              className="chat-input"
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Thinking...' : 'Ask'}
            </button>
          </form>
          {answer && (
            <div className="answer-box">
              <p>{answer}</p>
            </div>
          )}
        </section>

        <section className="glass-card suggestions-card">
          <h3>Reorganization Suggestions</h3>
          <div className="suggestions-list">
            {suggestions.map(s => (
              <div key={s.id} className="suggestion-item">
                <div className="suggestion-info">
                  <span className="file-name">{s.original_path}</span>
                  <p className="suggestion-reason">{s.reason}</p>
                </div>
                <button onClick={() => handleApprove(s.id)} className="approve-btn">Approve Move</button>
              </div>
            ))}
            {suggestions.length === 0 && <p className="empty-state">No pending suggestions</p>}
          </div>
        </section>

        <section className="glass-card inventory-card">
          <h3>Drive Inventory</h3>
          <div className="files-list">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Mime Type</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.id}>
                    <td className="file-name-cell">{f.name}</td>
                    <td className="mime-cell">{f.mimeType.split('/').pop()}</td>
                    <td className="summary-cell">{f.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length === 0 && <p className="empty-state">No files processed yet</p>}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
