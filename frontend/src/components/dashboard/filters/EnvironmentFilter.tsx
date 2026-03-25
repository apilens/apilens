'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface EnvironmentFilterProps {
  projectSlug: string;
  value?: string;
  onChange: (env?: string) => void;
}

export default function EnvironmentFilter({
  projectSlug,
  value,
  onChange,
}: EnvironmentFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [environments, setEnvironments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchEnvironments() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch (err) {
        console.error('Failed to fetch environments:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchEnvironments();
  }, [projectSlug]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value || undefined;
    onChange(newValue);

    // Update URL params
    const params = new URLSearchParams(searchParams.toString());
    if (newValue) {
      params.set('environment', newValue);
    } else {
      params.delete('environment');
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  if (loading) {
    return (
      <select className="environment-dropdown" disabled>
        <option>Loading...</option>
      </select>
    );
  }

  if (environments.length === 0) {
    return null;
  }

  return (
    <select
      className="environment-dropdown"
      value={value || ''}
      onChange={handleChange}
    >
      <option value="">All environments</option>
      {environments.map((env) => (
        <option key={env} value={env}>
          {env}
        </option>
      ))}
    </select>
  );
}
