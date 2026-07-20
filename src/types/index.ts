export type UserRole = 'admin' | 'caller';

export type User = {
  id: string;
  name: string;
  employeeId: string;
  phone: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  assignedLeads: number;
  lastLogin: string;
  avatar?: string;
  password?: string;
};

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'follow_up_pending'
  | 'interested'
  | 'call_back_later'
  | 'no_response'
  | 'not_interested'
  | 'converted'
  | 'closed';

export type LeadPriority = 'low' | 'medium' | 'high' | 'urgent';

export type LeadSource =
  | 'website'
  | 'referral'
  | 'walk_in'
  | 'phone'
  | 'social_media'
  | 'advertisement'
  | 'other';

export type LeadActivity = {
  id: string;
  leadId: string;
  type: 'call' | 'comment' | 'status_change' | 'follow_up' | 'assignment' | 'created';
  description: string;
  createdAt: string;
  createdBy: string;
};

export type LeadMedicineItem = {
  id: string;
  name: string;
  days: number;
};

export type Lead = {
  id: string;
  customerName: string;
  mobile: string;
  alternateNumber?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  medicines: LeadMedicineItem[];
  doctorName?: string;
  assignedCaller?: string;
  leadSource: LeadSource;
  priority: LeadPriority;
  status: LeadStatus;
  createdDate: string;
  lastFollowUp?: string;
  nextFollowUp?: string;
  notes?: string;
  activities: LeadActivity[];
};

export type DosageForm = 'tablet' | 'capsule' | 'syrup' | 'injection' | 'other';

export type Medicine = {
  id: string;
  name: string;
  genericName?: string;
  dosageForm?: DosageForm;
  unitPrice: number;
  isActive: boolean;
  createdDate: string;
};

export type OrderStage =
  | 'lead'
  | 'confirmed'
  | 'medicine_prepared'
  | 'packed'
  | 'shipped'
  | 'delivered';

export type PaymentStatus = 'pending' | 'partial' | 'paid' | 'refunded';

export type Order = {
  id: string;
  orderNumber: string;
  leadId: string;
  customerName: string;
  address: string;
  medicines: { name: string; quantity: number; price: number }[];
  totalAmount: number;
  paymentStatus: PaymentStatus;
  stage: OrderStage;
  createdDate: string;
  updatedDate: string;
};

export type RenewalStatus = 'upcoming' | 'due_today' | 'overdue' | 'renewed';

export type Renewal = {
  id: string;
  customerId: string;
  customerName: string;
  medicineName: string;
  orderDate: string;
  renewalDate: string;
  expiryDate: string;
  daysRemaining: number;
  assignedCaller?: string;
  status: RenewalStatus;
};

export type FollowUp = {
  id: string;
  leadId?: string;
  customerName: string;
  scheduledDate: string;
  type: 'call' | 'reminder' | 'callback';
  status: 'pending' | 'completed' | 'missed';
  notes?: string;
};

export type Notification = {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  read: boolean;
  createdAt: string;
};

export type DashboardStats = {
  totalLeads: number;
  todaysCalls: number;
  pendingFollowUps: number;
  totalOrders: number;
  renewalsDue: number;
  leadStatusBreakdown: { status: LeadStatus; count: number }[];
  callerPerformance: {
    id: string;
    name: string;
    assignedCount: number;
    convertedCount: number;
    conversionRate: number;
  }[];
};

export type AppState = {
  currentUser: User | null;
  users: User[];
  leads: Lead[];
  orders: Order[];
  renewals: Renewal[];
  followUps: FollowUp[];
  notifications: Notification[];
  medicines: Medicine[];
  dashboard: DashboardStats | null;
  searchQuery: string;
  booting: boolean;
};

export type HydratePayload = {
  users: User[];
  leads: Lead[];
  orders: Order[];
  renewals: Renewal[];
  followUps: FollowUp[];
  notifications: Notification[];
  medicines: Medicine[];
  dashboard: DashboardStats;
};

export type AppAction =
  | { type: 'LOGIN'; payload: { user: User } }
  | { type: 'LOGOUT' }
  | { type: 'HYDRATE'; payload: HydratePayload }
  | { type: 'SET_BOOTING'; payload: { booting: boolean } }
  | { type: 'ADD_LEAD'; payload: { lead: Lead } }
  | { type: 'UPDATE_LEAD'; payload: { id: string; updates: Partial<Lead> } }
  | { type: 'DELETE_LEAD'; payload: { id: string } }
  | { type: 'ASSIGN_LEAD'; payload: { leadId: string; callerId: string } }
  | { type: 'ADD_USER'; payload: { user: User } }
  | { type: 'UPDATE_USER'; payload: { id: string; updates: Partial<User> } }
  | { type: 'DELETE_USER'; payload: { id: string } }
  | { type: 'ADD_ORDER'; payload: { order: Order } }
  | { type: 'UPDATE_ORDER'; payload: { id: string; updates: Partial<Order> } }
  | { type: 'ADD_RENEWAL'; payload: { renewal: Renewal } }
  | { type: 'UPDATE_RENEWAL'; payload: { id: string; updates: Partial<Renewal> } }
  | { type: 'ADD_FOLLOW_UP'; payload: { followUp: FollowUp } }
  | { type: 'UPDATE_FOLLOW_UP'; payload: { id: string; updates: Partial<FollowUp> } }
  | { type: 'ADD_NOTIFICATION'; payload: { notification: Notification } }
  | { type: 'MARK_NOTIFICATION_READ'; payload: { id: string } }
  | { type: 'SET_SEARCH_QUERY'; payload: { query: string } }
  | { type: 'ADD_LEAD_ACTIVITY'; payload: { leadId: string; activity: LeadActivity } }
  | { type: 'ADD_MEDICINE'; payload: { medicine: Medicine } }
  | { type: 'UPDATE_MEDICINE'; payload: { id: string; updates: Partial<Medicine> } }
  | { type: 'DELETE_MEDICINE'; payload: { id: string } };
