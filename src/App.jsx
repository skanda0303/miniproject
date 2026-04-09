import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const CATEGORY_ICONS = {
  'Finance': '💰',
  'Legal': '⚖️',
  'Education': '🎓',
  'Projects': '🚀',
  'Personal': '🏠',
  'Tech': '💻',
  'Work': '💼',
  'Resumes': '📄',
  'Uncategorized': '📁',
};

function App() {
  const [status, setStatus] = useState({ authenticated: false, fileCount: 0, indexingComplete: false });
  const [question, setQuestion] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('files');
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemma2:9b');

  const fetchData = async () => {
    try {
      const [statusRes, sugRes, filesRes] = await Promise.all([
        fetch('http://localhost:3001/api/status'),
        fetch('http://localhost:3001/api/suggestions'),
        fetch('http://localhost:3001/api/files')
      ]);
      const statusData = await statusRes.json();
      const sugData = await sugRes.json();
      const filesData = await filesRes.json();
      setStatus(statusData);
      setSuggestions(sugData);
      setFiles(filesData);
    } catch (e) {
      console.error('Data sync failed');
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleAsk = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;

    const userMsg = question;
    setQuestion('');
    setLoading(true);

    // Add User message then Assistant placeholder as separate entries
    const newHistory = [
      ...chatHistory,
      { role: 'user', content: userMsg },
      { role: 'assistant', content: 'Analyzing your files...' }
    ];
    setChatHistory(newHistory);

    try {
      const res = await fetch('http://localhost:3001/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userMsg,
          history: chatHistory.slice(-5).map(m => m.content), // Simplified history for server
          model: selectedModel
        })
      });
      const data = await res.json();

      // Update the last entry (the placeholder) with the real answer
      setChatHistory([
        ...newHistory.slice(0, -1),
        { role: 'assistant', content: data.answer || 'I couldn\'t find a specific answer.' }
      ]);
    } catch (e) {
      setChatHistory([
        ...newHistory.slice(0, -1),
        { role: 'assistant', content: 'Local AI is currently offline. Please check if Ollama is running.' }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    const res = await fetch('http://localhost:3001/auth/url');
    const data = await res.json();
    window.open(data.url, '_blank');
  };

  if (!status.authenticated) {
    return (
      <div className="auth-view">
        <h1 className="logo-text" style={{ fontSize: '5rem', marginBottom: '10px' }}>Intellect<span>.</span></h1>
        <p style={{ fontSize: '1.5rem', marginBottom: '30px', opacity: 0.8 }}>Intelligent Drive Management</p>
        <button onClick={handleConnect} className="btn-send" style={{ padding: '15px 40px', fontSize: '1.2rem' }}>
          Connect Google Drive
        </button>
      </div>
    );
  }

  const filteredFiles = files.filter(f =>
    f.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
    f.category?.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-text">Intellect<span>.</span></div>
        <div className="search-bar-container">
          <input
            type="text"
            className="search-bar"
            placeholder="Search documents..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div style={{ color: status.indexingComplete ? '#0ef' : '#f9ab00', fontSize: '0.9rem', fontWeight: 600 }}>
            {status.indexingComplete ? 'SYNCED' : 'INDEXING...'}
          </div>
          <div style={{ width: '40px', height: '40px', background: 'var(--main-color)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifySelf: 'center', textAlign: 'center', justifyContent: 'center', color: 'var(--bg-color)', fontWeight: 700 }}>S</div>
        </div>
      </header>

      <aside className="app-sidebar">
        <div className={`nav-item ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>
          My Storage
        </div>
        <div className={`nav-item ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>
          AI Assistant
        </div>
        <div className={`nav-item ${activeTab === 'suggestions' ? 'active' : ''}`} onClick={() => setActiveTab('suggestions')}>
          Optimize
          {suggestions.length > 0 && <span style={{ color: 'var(--main-color)', marginLeft: '10px' }}>[{suggestions.length}]</span>}
        </div>

        <div style={{ marginTop: 'auto' }}>
          <div className="nav-item" style={{ opacity: 0.6, fontSize: '0.9rem' }} onClick={() => fetch('http://localhost:3001/api/logout', { method: 'POST' }).then(() => window.location.reload())}>
            Logout Session
          </div>
        </div>
      </aside>

      <main className="app-main">
        {activeTab === 'files' && (
          <div className="files-area">
            <h2 style={{ fontSize: '2rem', marginBottom: '30px' }}>My <span>Storage</span></h2>
            <div className="file-grid">
              {filteredFiles.map(file => (
                <a key={file.id}
                  href={`https://drive.google.com/file/d/${file.id}/view`}
                  target="_blank"
                  rel="noreferrer"
                  className="file-card">
                  <div className="file-icon-box">{CATEGORY_ICONS[file.category] || '📄'}</div>
                  <div className="file-title">{file.name}</div>
                  <div className="file-tag">{file.category}</div>
                  <p style={{ fontSize: '0.8rem', marginTop: '15px', opacity: 0.7, height: '3em', overflow: 'hidden' }}>
                    {file.summary || 'Analyzing content...'}
                  </p>
                </a>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="chat-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '2rem', margin: 0 }}>Smart <span>Assistant</span></h2>
              <div className="model-selector">
                <select 
                  value={selectedModel} 
                  onChange={(e) => setSelectedModel(e.target.value)}
                  style={{ 
                    background: 'var(--second-bg-color)', 
                    color: 'white', 
                    border: '1px solid var(--main-color)', 
                    padding: '8px 15px', 
                    borderRadius: '10px',
                    fontSize: '0.85rem',
                    cursor: 'pointer'
                  }}
                >
                  <option value="gemma2:9b">Gemma 2 (9B)</option>
                  <option value="qwen3:8b">Qwen 3 (8B)</option>
                </select>
              </div>
            </div>
            <div className="chat-messages">
              {chatHistory.length === 0 && (
                <div style={{ margin: 'auto', textAlign: 'center', opacity: 0.5 }}>
                  <div style={{ fontSize: '4rem', marginBottom: '10px' }}>💬</div>
                  <p>Ask me about your documents, USNs, or categorization.</p>
                </div>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} className={`msg-wrapper ${msg.role === 'user' ? 'user' : 'ai'}`}>
                  <div className="msg-bubble">
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '10px', opacity: 0.6 }}>
                      {msg.role === 'user' ? 'YOU' : 'INTELLECT'}
                    </div>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="chat-input-area">
              <form className="chat-input-form" onSubmit={handleAsk}>
                <input
                  type="text"
                  placeholder="Ask Intellect anything..."
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" className="btn-send" disabled={loading}>
                  {loading ? '...' : 'Send'}
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'suggestions' && (
          <div className="suggestions-area">
            <h2 style={{ fontSize: '2rem', marginBottom: '30px' }}>Optimize <span>Drive</span></h2>
            {suggestions.length === 0 ? (
              <div style={{ padding: '50px', background: 'var(--second-bg-color)', borderRadius: '2rem', textAlign: 'center', opacity: 0.6 }}>
                Drive is currently optimal.
              </div>
            ) : (
              suggestions.map(s => (
                <div key={s.id} className="file-card" style={{ textAlign: 'left', cursor: 'default', marginBottom: '20px', width: '100%' }}>
                  <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                    <div style={{ fontSize: '3rem' }}>�</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '1.2rem', color: 'var(--main-color)' }}>REORGANIZATION REQUEST</div>
                      <p style={{ marginTop: '5px' }}>Move <strong>{s.original_path}</strong> to <strong>{s.suggested_path}</strong></p>
                      <p style={{ fontSize: '0.85rem', opacity: 0.7, marginTop: '10px' }}>{s.reason}</p>
                      <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
                        <button className="btn-send" onClick={() => fetch('http://localhost:3001/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) }).then(() => fetchData())}>Approve Action</button>
                        <button className="btn-send" style={{ background: 'transparent', border: '2px solid var(--main-color)', color: 'var(--main-color)' }} onClick={() => fetch('http://localhost:3001/api/deny', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) }).then(() => fetchData())}>Dismiss</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
