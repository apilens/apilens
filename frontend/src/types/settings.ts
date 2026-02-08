export interface ActiveSession {
  id: string;
  device_info: string;
  ip_address: string | null;
  last_used_at: string;
  created_at: string;
  is_current: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  picture: string;
  email_verified: boolean;
  has_password: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

export interface ProfileResponse {
  profile: UserProfile;
}
