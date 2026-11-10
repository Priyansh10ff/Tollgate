/** A generic modern smartphone showing Tollgate's approval notification on the lock screen. */
export function Phone() {
  return (
    <div className="phone-wrap rv2">
      <figure className="device" aria-label="Phone lock screen with a Tollgate notification asking to approve a $0.50 payment">
        <span className="device-btn vol-up" aria-hidden="true" />
        <span className="device-btn vol-down" aria-hidden="true" />
        <span className="device-btn power" aria-hidden="true" />
        <div className="device-screen">
          <div className="lock-wallpaper" aria-hidden="true" />

          <div className="status-bar" aria-hidden="true">
            <span className="sb-time">9:41</span>
            <span className="punch-hole" />
            <span className="sb-icons">
              <svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></svg>
              <svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 2.2c2.2 0 4.2.8 5.7 2.2l1.2-1.3C12.6 1.4 10.2.4 7.5.4S2.4 1.4.6 3.1l1.2 1.3c1.5-1.4 3.5-2.2 5.7-2.2Zm0 3.4c1.3 0 2.5.5 3.4 1.3l1.2-1.3A6.7 6.7 0 0 0 7.5 3.8c-1.8 0-3.4.7-4.6 1.8l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3Zm0 3.3c.5 0 .9.2 1.2.5L7.5 10.8 6.3 9.4c.3-.3.7-.5 1.2-.5Z" /></svg>
              <span className="battery"><span className="battery-level" /></span>
            </span>
          </div>

          <div className="lock-clock" aria-hidden="true">
            <div className="lock-date">Tuesday, 10 November</div>
            <div className="lock-time">9:41</div>
          </div>

          <div className="lock-notifs">
            <div className="os-notif buzz">
              <div className="os-notif-head">
                <span className="app-icon serif" aria-hidden="true">T</span>
                <span className="os-app">Tollgate</span>
                <span className="os-when">now</span>
              </div>
              <div className="os-notif-title">Research Agent wants to spend $0.50</div>
              <div className="os-notif-body">Analyst report · Northwind Robotics · Atlas Data. Over your $0.25 ask-me limit.</div>
              <div className="os-notif-actions" aria-hidden="true">
                <span className="os-action primary">Approve</span>
                <span className="os-action">Deny</span>
              </div>
            </div>
            <div className="os-notif secondary">
              <div className="os-notif-head">
                <span className="app-icon serif" aria-hidden="true">T</span>
                <span className="os-app">Tollgate</span>
                <span className="os-when">2m ago</span>
              </div>
              <div className="os-notif-body">Blocked $0.40 to QuickLeads. It isn't on your allowed list, so no money moved.</div>
            </div>
          </div>

          <div className="lock-bottom" aria-hidden="true">
            <span className="lock-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2h8l-1 6H9L8 2Z" /><path d="M9 8v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8" /><path d="M12 12v3" /></svg>
            </span>
            <span className="lock-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
            </span>
          </div>
          <div className="home-bar" aria-hidden="true" />
        </div>
      </figure>
    </div>
  );
}
