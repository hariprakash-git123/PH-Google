import React from 'react';
import './StatCard.css';

export default function StatCard({ item }) {
  return (
    <div className="ph-stat-card ph-card">
      <div className="ph-stat-header">
        <span className="ph-stat-label">{item.label}</span>
        <span className={`ph-stat-change ph-stat-${item.status}`}>{item.change}</span>
      </div>
      <div className="ph-stat-value">{item.value}</div>
      <div className="ph-stat-subtext">{item.subtext}</div>
    </div>
  );
}
