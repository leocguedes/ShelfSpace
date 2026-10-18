import{useEffect,useMemo,useRef,useState}from'react';
import type{ReactNode}from'react';
import{formatQuantity,quantityStep,searchKey,units}from'./lib/domain';
import type{Unit}from'./lib/domain';
import{convertRecipeQuantity,getRecipeIngredientStatuses,matchesRecipeIngredient,recipes}from'./lib/recipes';
import type{Recipe,RecipeIngredient,RecipePantryItem}from'./lib/recipes';
import{Apple,ArrowDownUp,Bell,BookOpen,Box,CalendarClock,Check,ChevronDown,ChevronRight,ClipboardList,Copy,Edit3,Home,LayoutGrid,List,LockKeyhole,Minus,MoreHorizontal,MoveRight,PackagePlus,Plus,Search,Settings,ShoppingCart,Trash2,Users,X}from'lucide-react';
import{supabase}from'./lib/supabase';

type RecentFood={name:string;unit:Unit};
type Food={id:string;name:string;quantity:number;unit:Unit;expires_on?:string|null};
type ConsumptionRule={id:string;household_id:string;food_id:string;amount:number;period_days:number;next_suggestion_on:string;low_stock_threshold:number|null;restock_quantity:number|null;is_active:boolean;created_by:string|null;last_confirmed_at:string|null};
type Sub={id:string;name:string;foods:Food[]};
type Place={id:string;name:string;subdivisions:Sub[]};
type Household={id:string;name:string;created_by:string|null;is_personal:boolean;role:'owner'|'admin'|'member'};
type HouseholdMember={user_id:string;email:string;display_name:string;role:'owner'|'admin'|'member';joined_at:string};
type ShoppingItem={id:string;household_id:string;name:string;quantity:number;unit:string;category?:string|null;is_purchased:boolean;source:string;linked_food_id?:string|null;notes?:string|null;created_by:string|null;purchased_by?:string|null;purchased_at?:string|null;created_at?:string;recurring_rule_id?:string|null;recurring_occurrence?:string|null};
type RecurringShoppingRule={id:string;household_id:string;name:string;quantity:number;unit:string;frequency_days:number;next_due_on:string;is_active:boolean;created_by:string|null;created_at?:string;};
type UndoState={label:string;action:()=>void};
type SyncTable='locations'|'subdivisions'|'foods'|'shopping_items'|'recurring_shopping_items'|'food_consumption_rules'|'food_consumption_events';
type SyncAction='insert'|'upsert'|'update'|'delete';
type PendingOperation={id:string;userId:string;table:SyncTable;action:SyncAction;rowId?:string;data?:Record<string,unknown>};

const recentFoodsKey='organizapp-recent-foods';
const userRecentFoodsKey=(userId:string)=>`organizapp-recent-foods-user-${userId}`;
const localOwnerKey='organizapp-local-owner';
const legacyLocalKey='organizapp';
const anonymousLocalKey='organizapp-anonymous';
const userLocalKey=(userId:string)=>`organizapp-user-${userId}`;
const householdPlacesKey=(userId:string,householdId:string)=>`organizapp-user-${userId}-household-${householdId}`;
const activeHouseholdKey=(userId:string)=>`organizapp-active-household-${userId}`;
const householdShoppingKey=(userId:string,householdId:string)=>`organizapp-shopping-${userId}-${householdId}`;
const pendingSyncKey='organizapp-pending-sync';
const uid=()=>crypto.randomUUID();
function localDateString(date=new Date()){
  const year=date.getFullYear();
  const month=String(date.getMonth()+1).padStart(2,'0');
  const day=String(date.getDate()).padStart(2,'0');
  return year+'-'+month+'-'+day;
}
function addIsoDays(dateText:string,days:number){
  const parts=dateText.split('-').map(Number);
  const date=new Date(parts[0],parts[1]-1,parts[2],12);
  date.setDate(date.getDate()+days);
  return localDateString(date);
}
function daysUntilExpiry(dateText:string){
  const parts=dateText.split('-').map(Number);
  const expiry=new Date(parts[0],parts[1]-1,parts[2]);
  const now=new Date();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  return Math.round((expiry.getTime()-today.getTime())/86400000);
}
function expiryCaption(dateText:string){
  const days=daysUntilExpiry(dateText);
  if(days<0)return 'Vencido há '+Math.abs(days)+' '+(Math.abs(days)===1?'dia':'dias');
  if(days===0)return 'Vence hoje';
  if(days===1)return 'Vence amanhã';
  return 'Vence em '+days+' dias';
}
function locationPhotoClass(name:string){
  const normalized=name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/geladeira|refrigerador|fridge/.test(normalized))return 'photo-fridge';
  if(/freezer|congelador/.test(normalized))return 'photo-freezer';
  if(/despensa|pantry/.test(normalized))return 'photo-pantry';
  if(/armario|cabinet|cupboard/.test(normalized))return 'photo-cabinet';
  if(/gaveta|drawer/.test(normalized))return 'photo-drawer';
  if(/bancada|countertop|counter/.test(normalized))return 'photo-counter';
  if(/prateleira|shelf|shelving/.test(normalized))return 'photo-shelf';
  if(/estoque|stockroom|bulk storage/.test(normalized))return 'photo-stockroom';
  if(/deposito|storeroom|storage room/.test(normalized))return 'photo-storage';
  if(/frigobar|mini fridge|beverage fridge/.test(normalized))return 'photo-minifridge';
  return 'photo-generic';
}
const authRedirectUrl=()=>new URL(import.meta.env.BASE_URL,window.location.origin).toString();
const makeSub=(name:string,foods:Food[]=[]):Sub=>({id:uid(),name,foods});
const initial:Place[]=[];
const anonymousPreviewPlaces=():Place[]=>[
  {id:uid(),name:'Geladeira',subdivisions:[makeSub('Geral')]},
  {id:uid(),name:'Freezer',subdivisions:[makeSub('Geral')]}
];

function normalize(raw:any):Place[]{
  if(!Array.isArray(raw))return [];
  return raw.map((p:any)=>{
    const oldSubs=Array.isArray(p.subdivisions)?p.subdivisions:[];
    const first=oldSubs[0];
    const foods=[...(p.foods||[]),...oldSubs.flatMap((sub:any)=>sub.foods||[])].map((f:any)=>({
      id:isUUID(f.id)?f.id:uid(),
      name:String(f.name??'').trim(),
      quantity:Math.max(0,Number.isFinite(Number(f.quantity))?Number(f.quantity):0),
      unit:units.includes(f.unit)?f.unit:'unidades',
      expires_on:typeof f.expires_on==='string'?f.expires_on:null
    }));
    return {id:isUUID(p.id)?p.id:uid(),name:String(p.name??'').trim(),subdivisions:[{id:isUUID(first?.id)?first.id:uid(),name:'Geral',foods}]};
  }).filter((p:Place)=>p.name);
}

function isUUID(v:any){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)}
function readStoredPlaces(key:string):Place[]|null{
  try{
    const raw=localStorage.getItem(key);
    return raw?normalize(JSON.parse(raw)):null;
  }catch{return null}
}

function getLocalOwner(){
  try{return localStorage.getItem(localOwnerKey)}catch{return null}
}

function setLocalOwner(userId:string|null){
  try{
    if(userId)localStorage.setItem(localOwnerKey,userId);
    else localStorage.removeItem(localOwnerKey);
  }catch{}
}

function readLocalPlaces(userId?:string|null){
  const scoped=readStoredPlaces(userId?userLocalKey(userId):anonymousLocalKey);
  if(scoped)return scoped;
  if(!userId&&!getLocalOwner()){
    const legacy=readStoredPlaces(legacyLocalKey);
    if(legacy)return legacy;
  }
  return [];
}

function readAnonymousPlaces(){
  const stored=readStoredPlaces(anonymousLocalKey);
  const legacy=!getLocalOwner()?readStoredPlaces(legacyLocalKey):null;
  const defaults=['Armário','Despensa','Freezer','Gavetas','Geladeira'];
  const isEmptyStarterInventory=(places:Place[]|null)=>!!places&&places.length===defaults.length
    &&[...places].sort((a,b)=>a.name.localeCompare(b.name)).every((place,index)=>
      place.name===defaults[index]&&place.subdivisions.every(sub=>sub.foods.length===0));
  // Remove the old five-location anonymous starter state without touching actual food data.
  if(isEmptyStarterInventory(stored)||isEmptyStarterInventory(legacy)){
    try{
      if(isEmptyStarterInventory(stored))localStorage.removeItem(anonymousLocalKey);
      if(isEmptyStarterInventory(legacy))localStorage.removeItem(legacyLocalKey);
      localStorage.removeItem(recentFoodsKey);
    }catch{}
  }
  const current=readLocalPlaces(null);
  if(current.length)return current;
  // Anonymous visitors get two empty example locations; signed-in accounts still start empty.
  const preview=anonymousPreviewPlaces();
  writeLocalPlaces(null,preview);
  return preview;
}

function readHouseholdPlaces(userId:string,householdId:string,isPersonal:boolean){
  const scoped=readStoredPlaces(householdPlacesKey(userId,householdId));
  if(scoped)return scoped;
  if(isPersonal){
    const legacy=readStoredPlaces(userLocalKey(userId));
    if(legacy)return legacy;
    // Never promote the anonymous preview/cache into a newly authenticated account.
    // Anonymous and account inventories must remain isolated unless an explicit import flow exists.
    return [];
  }
  return [];
}

function writeHouseholdPlaces(userId:string,householdId:string,places:Place[]){
  try{localStorage.setItem(householdPlacesKey(userId,householdId),JSON.stringify(places))}
  catch{}
}

function readShoppingCache(userId:string,householdId:string):ShoppingItem[]{
  try{
    const raw=JSON.parse(localStorage.getItem(householdShoppingKey(userId,householdId))||'[]');
    return Array.isArray(raw)?raw.map((item:any)=>({...item,quantity:Math.max(0,Number(item.quantity)||0),is_purchased:!!item.is_purchased})): [];
  }catch{return[]}
}

function writeShoppingCache(userId:string,householdId:string,items:ShoppingItem[]){
  try{localStorage.setItem(householdShoppingKey(userId,householdId),JSON.stringify(items))}
  catch{}
}

function mapShoppingItems(data:any[]):ShoppingItem[]{
  return(data||[]).map((item:any)=>({
    ...item,
    quantity:Math.max(0,Number(item.quantity)||0),
    unit:String(item.unit||'unidades'),
    is_purchased:!!item.is_purchased,
    source:String(item.source||'manual')
  }));
}

function readActiveHousehold(userId:string){
  try{return localStorage.getItem(activeHouseholdKey(userId))}catch{return null}
}

function writeActiveHousehold(userId:string,householdId:string){
  try{localStorage.setItem(activeHouseholdKey(userId),householdId)}catch{}
}

async function fetchHouseholdContext(userId:string,preferredId?:string|null){
  const{data:personalId,error:personalError}=await supabase.rpc('ensure_personal_household');
  if(personalError||!personalId)throw personalError||new Error('Não foi possível preparar sua casa.');
  const{data,error}=await supabase.from('households')
    .select('id,name,created_by,is_personal,household_members!inner(user_id,role)')
    .eq('household_members.user_id',userId)
    .order('created_at');
  if(error)throw error;
  const list:Household[]=(data||[]).map((h:any)=>{
    const membership=(h.household_members||[]).find((m:any)=>m.user_id===userId);
    return{id:h.id,name:h.name,created_by:h.created_by,is_personal:!!h.is_personal,role:membership?.role||'member'};
  });
  const requested=preferredId||readActiveHousehold(userId);
  const chosen=list.some(h=>h.id===requested)?requested:(list.some(h=>h.id===personalId)?personalId:list[0]?.id);
  if(!chosen)throw new Error('Nenhuma casa disponível para esta conta.');
  return{households:list,personalId:personalId as string,householdId:chosen,household:list.find(h=>h.id===chosen)!};
}

function writeLocalPlaces(userId:string|null,places:Place[]){
  try{localStorage.setItem(userId?userLocalKey(userId):anonymousLocalKey,JSON.stringify(places))}
  catch{}
}

function placesCacheSignature(places:Place[]){
  return JSON.stringify([...places].sort((a,b)=>a.id.localeCompare(b.id)).map(place=>({
    ...place,
    subdivisions:[...place.subdivisions].sort((a,b)=>a.id.localeCompare(b.id)).map(sub=>({
      ...sub,
      foods:[...sub.foods].sort((a,b)=>a.id.localeCompare(b.id))
    }))
  })));
}

function clearLegacyCachesIfMatching(userId:string,places:Place[]){
  const signature=placesCacheSignature(places);
  try{
    const owner=getLocalOwner();
    const anonymous=readStoredPlaces(anonymousLocalKey);
    const legacy=!owner||owner===userId?readStoredPlaces(legacyLocalKey):null;
    const anonymousSignature=anonymous?placesCacheSignature(anonymous):null;
    const legacySignature=legacy?placesCacheSignature(legacy):null;
    if(anonymous&&(anonymousSignature===signature||(legacySignature&&anonymousSignature===legacySignature))){
      localStorage.removeItem(anonymousLocalKey);
    }
    if(legacy&&legacySignature===signature&&(!owner||owner===userId)){
      localStorage.removeItem(legacyLocalKey);
    }
    setLocalOwner(userId);
  }catch{}
}

function readRecentFoods(userId:string|null):RecentFood[]{
  try{
    const raw=JSON.parse(localStorage.getItem(userId?userRecentFoodsKey(userId):recentFoodsKey)||'[]');
    return Array.isArray(raw)?raw.slice(0,8):[];
  }catch{return[]}
}

function writeRecentFoods(userId:string|null,foods:RecentFood[]){
  try{
    localStorage.setItem(userId?userRecentFoodsKey(userId):recentFoodsKey,JSON.stringify(foods.slice(0,8)));
  }catch{}
}

async function uploadLocal(userId:string,places:Place[],householdId?:string){
  for(const p of places){
    const{error:placeError}=await supabase.from('locations').upsert({id:p.id,user_id:userId,name:p.name,...(householdId?{household_id:householdId}:{})});
    if(placeError)throw placeError;
    for(const s of p.subdivisions){
      const{error:subError}=await supabase.from('subdivisions').upsert({id:s.id,user_id:userId,location_id:p.id,name:s.name});
      if(subError)throw subError;
      for(const f of s.foods){
        const{error:foodError}=await supabase.from('foods').upsert({id:f.id,user_id:userId,subdivision_id:s.id,name:f.name,quantity:f.quantity,unit:f.unit,expires_on:f.expires_on||null});
        if(foodError)throw foodError;
      }
    }
  }
}

function readPendingSync():PendingOperation[]{
  try{
    const raw=JSON.parse(localStorage.getItem(pendingSyncKey)||'[]');
    return Array.isArray(raw)?raw:[];
  }catch{return[]}
}

function writePendingSync(queue:PendingOperation[]){
  try{
    if(queue.length)localStorage.setItem(pendingSyncKey,JSON.stringify(queue));
    else localStorage.removeItem(pendingSyncKey);
  }catch{}
}

function operationKey(op:PendingOperation){
  return op.table+':'+op.action+':'+(op.rowId||String(op.data?.id||''));
}

function syncEntityKey(op:Pick<PendingOperation,'table'|'rowId'|'data'>){
  return op.table+':'+(op.rowId||String(op.data?.id||''));
}

function clearPendingForEntity(userId:string,operation:Omit<PendingOperation,'id'>){
  const entity=syncEntityKey(operation);
  if(entity.endsWith(':'))return;
  const queue=readPendingSync();
  const next=queue.filter(op=>!(op.userId===userId&&syncEntityKey(op)===entity));
  if(next.length!==queue.length)writePendingSync(next);
}

function queuePendingSync(operation:Omit<PendingOperation,'id'>){
  const queue=readPendingSync();
  const next=queue.filter(op=>!(op.userId===operation.userId&&operationKey(op)===operationKey({...operation,id:''})));
  next.push({...operation,id:uid()});
  writePendingSync(next);
}

async function applyPendingSync(op:PendingOperation){
  if(op.action==='insert'){
    const{error}=await supabase.from(op.table).insert(op.data||{});
    if(error?.code==='23505')return;
    if(error)throw error;
    return;
  }
  if(op.action==='upsert'){
    const{error}=await supabase.from(op.table).upsert(op.data||{});
    if(error)throw error;
    return;
  }
  if(op.action==='update'){
    const{error}=await supabase.from(op.table).update(op.data||{}).eq('id',op.rowId||'');
    if(error)throw error;
    return;
  }
  const{error}=await supabase.from(op.table).delete().eq('id',op.rowId||'');
  if(error)throw error;
}

async function flushPendingSync(userId:string){
  let queue=readPendingSync();
  const mine=queue.filter(op=>op.userId===userId);
  for(const op of mine){
    try{
      await applyPendingSync(op);
      queue=queue.filter(item=>item.id!==op.id);
      writePendingSync(queue);
    }catch{
      return false;
    }
  }
  return true;
}

async function writeOrQueue(userId:string,operation:Omit<PendingOperation,'id'>){
  if(!navigator.onLine){
    queuePendingSync(operation);
    return false;
  }
  try{
    await applyPendingSync({...operation,id:uid()});
    // A newer online write makes queued writes for the same row obsolete.
    // Clear them so reconnecting later cannot restore an older quantity/state.
    clearPendingForEntity(userId,operation);
    return true;
  }catch{
    queuePendingSync(operation);
    return false;
  }
}

function mapCloudPlaces(data:any[]):Place[]{
  return(data||[]).map((p:any)=>{
    const oldSubs=(p.subdivisions||[]).filter(Boolean);
    const first=oldSubs[0];
    const foods=oldSubs.flatMap((sub:any)=>(sub.foods||[]).filter(Boolean)).map((f:any)=>({
      id:isUUID(f.id)?f.id:uid(),name:String(f.name??'').trim(),
      quantity:Math.max(0,Number.isFinite(Number(f.quantity))?Number(f.quantity):0),
      unit:units.includes(f.unit)?f.unit:'unidades',expires_on:typeof f.expires_on==='string'?f.expires_on:null
    }));
    return {id:isUUID(p.id)?p.id:uid(),name:String(p.name??'').trim(),subdivisions:[{id:isUUID(first?.id)?first.id:uid(),name:'Geral',foods}]};
  });
}

function App(){
  const[places,setPlaces]=useState<Place[]>(()=>readAnonymousPlaces());
  const[recentFoods,setRecentFoods]=useState<RecentFood[]>(()=>readRecentFoods(null));
  const[userId,setUserId]=useState<string|null>(null);
  const[user,setUser]=useState<any>(null);
  const[synced,setSynced]=useState(false);
  const[cacheReady,setCacheReady]=useState(true);
  const[households,setHouseholds]=useState<Household[]>([]);
  const[householdId,setHouseholdId]=useState<string|null>(null);
  const[householdModal,setHouseholdModal]=useState(false);
  const[householdBusy,setHouseholdBusy]=useState(false);
  const[householdJoinCode,setHouseholdJoinCode]=useState('');
  const[householdInvite,setHouseholdInvite]=useState<{code:string;expiresAt:string}|null>(null);
  const[householdCopied,setHouseholdCopied]=useState(false);
  const[workspace,setWorkspace]=useState<'inventory'|'shopping'|'recipes'|'report'|'settings'>('inventory');
  const[reportSearch,setReportSearch]=useState('');
  const[reportLocation,setReportLocation]=useState('all');
  const[reportView,setReportView]=useState<'list'|'details'>('list');
  const[foodSort,setFoodSort]=useState<'name'|'expiry'|'quantity-asc'|'quantity-desc'>('name');
  const[reportSort,setReportSort]=useState<'name'|'expiry'|'location'|'quantity-asc'|'quantity-desc'>('name');
  const[shoppingItems,setShoppingItems]=useState<ShoppingItem[]>([]);
  const[recurringRules,setRecurringRules]=useState<RecurringShoppingRule[]>([]);
  const[recurringRuleBusy,setRecurringRuleBusy]=useState(false);
  const shoppingItemsRef=useRef<ShoppingItem[]>([]);
  const[shoppingLoading,setShoppingLoading]=useState(false);
  const[shoppingStockItem,setShoppingStockItem]=useState<ShoppingItem|null>(null);
  const[shoppingAddFood,setShoppingAddFood]=useState<Food|null>(null);
  const[zeroQtyConfirm,setZeroQtyConfirm]=useState<{placeId:string;subId:string;food:Food}|null>(null);
  const[consumptionRules,setConsumptionRules]=useState<ConsumptionRule[]>([]);
  const[notificationCenterOpen,setNotificationCenterOpen]=useState(false);
  const[handledNotifications,setHandledNotifications]=useState<string[]>([]);
  const[consumptionRuleModal,setConsumptionRuleModal]=useState<{foodId:string}|null>(null);
  const[cookConfirmRecipe,setCookConfirmRecipe]=useState<Recipe|null>(null);
  const[online,setOnline]=useState(()=>navigator.onLine);
  const[authBusy,setAuthBusy]=useState(false);
  const[authMessage,setAuthMessage]=useState<string|null>(null);
  const[authModal,setAuthModal]=useState(false);
  const[passwordRecovery,setPasswordRecovery]=useState(false);
  const[passwordChangeModal,setPasswordChangeModal]=useState(false);
  const[signOutConfirm,setSignOutConfirm]=useState(false);
   const[deleteAccountConfirm,setDeleteAccountConfirm]=useState(false);
  const[selected,setSelected]=useState<string|null>(null);
  const[selectedSub,setSelectedSub]=useState<string|null>(null);
  const[search,setSearch]=useState('');
  const[localFoodSearch,setLocalFoodSearch]=useState('');
  const[foodModal,setFoodModal]=useState<{place:string;sub:string;food?:Food}|null>(null);
  const[importModal,setImportModal]=useState(false);
  const[addActionModal,setAddActionModal]=useState(false);
  const[moveModal,setMoveModal]=useState<{place:string;sub:string;food:Food}|null>(null);
  const[foodMenu,setFoodMenu]=useState<string|null>(null);
  const[placeModal,setPlaceModal]=useState(false);
  const[placeToEdit,setPlaceToEdit]=useState<string|null>(null);
  const[subModal,setSubModal]=useState<{place:string;sub?:Sub}|null>(null);
  const[undo,setUndo]=useState<UndoState|null>(null);
  const[actionFeedback,setActionFeedback]=useState<string|null>(null);
  const feedbackTimer=useRef<number|null>(null);
  const undoTimer=useRef<number|null>(null);
  const authRequest=useRef(0);
  const realtimeRefreshTimer=useRef<number|null>(null);

  function clearTransientUi(){
    setSelected(null);
    setSelectedSub(null);
    setWorkspace('inventory');
    setSearch('');
    setFoodModal(null);
    setMoveModal(null);
    setFoodMenu(null);
    setPlaceModal(false);
    setPlaceToEdit(null);
    setSubModal(null);
    setShoppingStockItem(null);
    setConsumptionRuleModal(null);
    setCookConfirmRecipe(null);
    setUndo(null);
  }

  useEffect(()=>{
    let active=true;
    const load=async()=>{
      const request=++authRequest.current;
      const{data:session}=await supabase.auth.getSession();
      const current=session.session?.user||null;
      const anonymousLocal=readAnonymousPlaces();
      if(!active||request!==authRequest.current)return;
      if(!current){
        setCacheReady(true);
        setUser(null);
        setUserId(null);
        setHouseholds([]);
        setHouseholdId(null);
        setSynced(false);
        setPlaces(anonymousLocal);
        return;
      }
      setCacheReady(false);
      setUser(current);
      setUserId(current.id);
      setRecentFoods(readRecentFoods(current.id));
      let context;
      try{
        context=await fetchHouseholdContext(current.id);
      }catch{
        if(!active||request!==authRequest.current)return;
        setAuthMessage('Não foi possível carregar as casas compartilhadas. Seus dados locais continuam preservados.');
        setPlaces(readLocalPlaces(current.id));
        setSynced(false);
        setCacheReady(true);
        return;
      }
      if(!active||request!==authRequest.current)return;
      setHouseholds(context.households);
      setHouseholdId(context.householdId);
      writeActiveHousehold(current.id,context.householdId);
      const accountLocal=readHouseholdPlaces(current.id,context.householdId,context.household.is_personal);
      setPlaces(accountLocal);
      const pendingOk=await flushPendingSync(current.id);
      if(!active||request!==authRequest.current)return;
      if(!pendingOk){
        setSynced(false);
        setAuthMessage('Há alterações aguardando sincronização. Seus dados locais continuam disponíveis.');
        setCacheReady(true);
        return;
      }
      const{data,error}=await supabase.from('locations')
        .select('id,name,subdivisions(id,name,foods(id,name,quantity,unit,expires_on))')
        .eq('household_id',context.householdId)
        .order('created_at');
      if(!active||request!==authRequest.current)return;
      if(error){
        setAuthMessage('Não foi possível sincronizar agora. Seus dados locais continuam disponíveis.');
        setCacheReady(true);
        return;
      }
      const cloudPlaces=mapCloudPlaces(data||[]);
      if(cloudPlaces.length){
        setPlaces(cloudPlaces);
        writeHouseholdPlaces(current.id,context.householdId,cloudPlaces);
        clearLegacyCachesIfMatching(current.id,cloudPlaces);
        setSynced(true);
        setCacheReady(true);
        return;
      }
      if(accountLocal.length){
        setPlaces(accountLocal);
        writeHouseholdPlaces(current.id,context.householdId,accountLocal);
        try{
          await uploadLocal(current.id,accountLocal,context.householdId);
          if(!active||request!==authRequest.current)return;
          clearLegacyCachesIfMatching(current.id,accountLocal);
          setSynced(true);
        }catch{
          if(!active||request!==authRequest.current)return;
          setSynced(false);
          setAuthMessage('Seus dados locais foram preservados enquanto a sincronização é recuperada.');
        }
      }else{
        setPlaces([]);
        writeHouseholdPlaces(current.id,context.householdId,[]);
        setSynced(true);
      }
      if(active&&request===authRequest.current)setCacheReady(true);
    };
    load();
    const{data:listener}=supabase.auth.onAuthStateChange((event,session)=>{
      if(!active)return;
      if(event==='SIGNED_OUT'||event==='USER_UPDATED')++authRequest.current;
      if(event==='SIGNED_IN'&&session?.user){
        clearTransientUi();
        setCacheReady(false);
        setRecentFoods(readRecentFoods(session.user.id));
      }
      if(event==='SIGNED_OUT'){
        clearTransientUi();
        setRecentFoods(readRecentFoods(null));
      }
      if(event==='PASSWORD_RECOVERY'){
        setPasswordRecovery(true);
        setAuthMessage(null);
      }
      if(!session?.user){
        setUser(null);
        setUserId(null);
        setHouseholds([]);
        setHouseholdId(null);
        setSynced(false);
        setCacheReady(true);
        setPlaces(readAnonymousPlaces());
        setRecentFoods(readRecentFoods(null));
        return;
      }
      setUser(session.user);
      setUserId(session.user.id);
    });
    return()=>{active=false;listener.subscription.unsubscribe()};
  },[]);

  useEffect(()=>{
    if(!userId||!householdId){
      shoppingItemsRef.current=[];
      setShoppingItems([]);
      setShoppingLoading(false);
      return;
    }
    let active=true;
    const accountId=userId;
    const activeHouse=householdId;
    const cachedItems=readShoppingCache(accountId,activeHouse);
    shoppingItemsRef.current=cachedItems;
    setShoppingItems(cachedItems);
    setShoppingLoading(true);
    void (async()=>{
      try{
        const{error:recurringError}=await supabase.rpc('materialize_due_recurring_shopping_items',{target_household_id:activeHouse});
        if(!active)return;
        if(recurringError)setAuthMessage('Não foi possível atualizar as reposições recorrentes agora.');
        const{data,error}=await supabase.from('shopping_items').select('*')
          .eq('household_id',activeHouse)
          .order('is_purchased',{ascending:true})
          .order('created_at',{ascending:false});
        if(!active)return;
        if(error){
          setAuthMessage('A lista de compras está disponível em cache, mas não foi possível sincronizá-la agora.');
          const fallbackItems=readShoppingCache(accountId,activeHouse);
          shoppingItemsRef.current=fallbackItems;
          setShoppingItems(fallbackItems);
          return;
        }
        const items=mapShoppingItems(data||[]);
        shoppingItemsRef.current=items;
        setShoppingItems(items);
        writeShoppingCache(accountId,activeHouse,items);
      }finally{
        if(active)setShoppingLoading(false);
      }
    })();
    return()=>{active=false};
  },[userId,householdId]);

  useEffect(()=>{
    if(!userId||!householdId){
      setRecurringRules([]);
      return;
    }
    let active=true;
    void (async()=>{
      await supabase.rpc('materialize_due_recurring_shopping_items',{target_household_id:householdId});
      if(!active)return;
      const{data,error}=await supabase.from('recurring_shopping_items').select('*')
        .eq('household_id',householdId)
        .order('next_due_on',{ascending:true});
      if(!active)return;
      if(!error)setRecurringRules((data||[]).map((item:any)=>({...item,quantity:Number(item.quantity)||0,frequency_days:Number(item.frequency_days)||7})));
    })();
    return()=>{active=false};
  },[userId,householdId]);

  useEffect(()=>{
    const key='organizapp-handled-notifications-'+(userId||'anonymous')+'-'+(householdId||'local');
    try{const raw=JSON.parse(localStorage.getItem(key)||'[]');setHandledNotifications(Array.isArray(raw)?raw:[])}catch{setHandledNotifications([])}
    setNotificationCenterOpen(false);
  },[userId,householdId]);

  useEffect(()=>{
    const key='organizapp-handled-notifications-'+(userId||'anonymous')+'-'+(householdId||'local');
    try{localStorage.setItem(key,JSON.stringify(handledNotifications))}catch{}
  },[handledNotifications,userId,householdId]);

  useEffect(()=>{
    if(!userId||!householdId){
      setConsumptionRules([]);
      return;
    }
    let active=true;
    const accountId=userId;
    const activeHouse=householdId;
    void (async()=>{
      const{data,error}=await supabase.from('food_consumption_rules').select('*')
        .eq('household_id',activeHouse)
        .eq('is_active',true)
        .order('next_suggestion_on',{ascending:true});
      if(!active)return;
      if(!error)setConsumptionRules((data||[]) as ConsumptionRule[]);
    })();
    return()=>{active=false};
  },[userId,householdId]);

  useEffect(()=>{
    if(!cacheReady)return;
    if(userId&&householdId)writeHouseholdPlaces(userId,householdId,places);
    else writeLocalPlaces(userId,places);
  },[cacheReady,userId,householdId,places]);

  useEffect(()=>{
    const updateOnline=()=>setOnline(navigator.onLine);
    window.addEventListener('online',updateOnline);
    window.addEventListener('offline',updateOnline);
    return()=>{window.removeEventListener('online',updateOnline);window.removeEventListener('offline',updateOnline)};
  },[]);

  useEffect(()=>{
    if(!authMessage)return;
    const timer=window.setTimeout(()=>setAuthMessage(null),6000);
    return()=>window.clearTimeout(timer);
  },[authMessage]);

  async function refreshCloud(userIdToLoad=userId){
    const householdIdToLoad=householdId;
    if(!userIdToLoad||userIdToLoad!==userId||!householdIdToLoad)return;
    const request=authRequest.current;
    const pendingOk=await flushPendingSync(userIdToLoad);
    if(request!==authRequest.current||userIdToLoad!==userId||householdIdToLoad!==householdId)return;
    if(!pendingOk){setSynced(false);return}
    const{data,error}=await supabase.from('locations')
      .select('id,name,subdivisions(id,name,foods(id,name,quantity,unit,expires_on))')
      .eq('household_id',householdIdToLoad)
      .order('created_at');
    if(request!==authRequest.current||userIdToLoad!==userId||householdIdToLoad!==householdId)return;
    if(error){
      setSynced(false);
      return;
    }
    const cloudPlaces=mapCloudPlaces(data||[]);
    if(cloudPlaces.length){
      setPlaces(cloudPlaces);
      writeHouseholdPlaces(userIdToLoad,householdIdToLoad,cloudPlaces);
      clearLegacyCachesIfMatching(userIdToLoad,cloudPlaces);
      setSynced(true);
      return;
    }

    const activeHousehold=households.find(h=>h.id===householdIdToLoad);
    const recoveryCache=readHouseholdPlaces(userIdToLoad,householdIdToLoad,!!activeHousehold?.is_personal);
    if(!recoveryCache.length){
      setPlaces([]);
      writeHouseholdPlaces(userIdToLoad,householdIdToLoad,[]);
      setSynced(true);
      return;
    }
    setPlaces(recoveryCache);
    writeHouseholdPlaces(userIdToLoad,householdIdToLoad,recoveryCache);
    try{
      await uploadLocal(userIdToLoad,recoveryCache,householdIdToLoad);
      if(request!==authRequest.current||userIdToLoad!==userId||householdIdToLoad!==householdId)return;
      clearLegacyCachesIfMatching(userIdToLoad,recoveryCache);
      setSynced(true);
    }catch{
      if(request!==authRequest.current||userIdToLoad!==userId||householdIdToLoad!==householdId)return;
      setSynced(false);
      setAuthMessage('Seus dados locais foram preservados enquanto a sincronização é recuperada.');
    }
  }

  async function refreshShoppingList(targetUser=userId,targetHouse=householdId){
    if(!targetUser||!targetHouse||targetUser!==userId||targetHouse!==householdId||!navigator.onLine)return;
    const request=authRequest.current;
    const{error:recurringError}=await supabase.rpc('materialize_due_recurring_shopping_items',{target_household_id:targetHouse});
    if(request!==authRequest.current||targetUser!==userId||targetHouse!==householdId)return;
    const{data,error}=await supabase.from('shopping_items').select('*')
      .eq('household_id',targetHouse)
      .order('is_purchased',{ascending:true})
      .order('created_at',{ascending:false});
    if(request!==authRequest.current||targetUser!==userId||targetHouse!==householdId)return;
    if(error){
      setAuthMessage('A lista de compras está em cache; a sincronização será retomada quando estiver disponível.');
      return;
    }
    const items=mapShoppingItems(data||[]);
    shoppingItemsRef.current=items;
    setShoppingItems(items);
    writeShoppingCache(targetUser,targetHouse,items);
    if(recurringError)setAuthMessage('A lista atualizou, mas não foi possível processar todas as reposições recorrentes.');
  }

  async function refreshRecurringRules(targetUser=userId,targetHouse=householdId){
    if(!targetUser||!targetHouse||targetUser!==userId||targetHouse!==householdId)return;
    const{data,error}=await supabase.from('recurring_shopping_items').select('*')
      .eq('household_id',targetHouse).order('next_due_on',{ascending:true});
    if(error||targetUser!==userId||targetHouse!==householdId)return;
    setRecurringRules((data||[]).map((item:any)=>({...item,quantity:Number(item.quantity)||0,frequency_days:Number(item.frequency_days)||7})));
  }

  async function refreshConsumptionRules(targetUser=userId,targetHouse=householdId){
    if(!targetUser||!targetHouse||targetUser!==userId||targetHouse!==householdId)return;
    const{data,error}=await supabase.from('food_consumption_rules').select('*')
      .eq('household_id',targetHouse).eq('is_active',true).order('next_suggestion_on',{ascending:true});
    if(error||targetUser!==userId||targetHouse!==householdId)return;
    setConsumptionRules((data||[]) as ConsumptionRule[]);
  }

  useEffect(()=>{
    if(!userId||!householdId)return;
    const activeUser=userId;
    const activeHouse=householdId;
    const refresh=()=>{
      if(!navigator.onLine)return;
      void refreshCloud(activeUser);
      void refreshShoppingList(activeUser,activeHouse);
      void refreshRecurringRules(activeUser,activeHouse);
      void refreshConsumptionRules(activeUser,activeHouse);
    };
    window.addEventListener('focus',refresh);
    window.addEventListener('online',refresh);
    return()=>{
      window.removeEventListener('focus',refresh);
      window.removeEventListener('online',refresh);
    };
  },[userId,householdId]);

  useEffect(()=>{
    if(!userId||!householdId)return;
    const activeUser=userId;
    const activeHouse=householdId;
    const channel=supabase.channel('household-live-'+activeHouse)
      .on('postgres_changes',{event:'*',schema:'public',table:'locations',filter:'household_id=eq.'+activeHouse},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'subdivisions'},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'foods'},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'shopping_items',filter:'household_id=eq.'+activeHouse},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'recurring_shopping_items',filter:'household_id=eq.'+activeHouse},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'food_consumption_rules',filter:'household_id=eq.'+activeHouse},()=>{
        scheduleHouseholdRefresh(activeUser,activeHouse);
      })
      .subscribe();
    return()=>{
      if(realtimeRefreshTimer.current!==null){
        window.clearTimeout(realtimeRefreshTimer.current);
        realtimeRefreshTimer.current=null;
      }
      void supabase.removeChannel(channel);
    };
  },[userId,householdId]);

  function scheduleHouseholdRefresh(targetUser:string,targetHouse:string){
    if(realtimeRefreshTimer.current!==null)window.clearTimeout(realtimeRefreshTimer.current);
    realtimeRefreshTimer.current=window.setTimeout(()=>{
      realtimeRefreshTimer.current=null;
      if(targetUser!==userId||targetHouse!==householdId||!navigator.onLine)return;
      void refreshCloud(targetUser);
      void refreshShoppingList(targetUser,targetHouse);
      void refreshRecurringRules(targetUser,targetHouse);
      void refreshConsumptionRules(targetUser,targetHouse);
    },350);
  }

  function rememberFood(name:string,unit:Unit){
    setRecentFoods(prev=>{
      const key=searchKey(name.trim());
      const next=[{name:name.trim(),unit},...prev.filter(f=>searchKey(f.name.trim())!==key)].slice(0,8);
      writeRecentFoods(userId,next);
      return next;
    });
  }

  useEffect(()=>{
    if(!foodMenu)return;
    const close=()=>setFoodMenu(null);
    document.addEventListener('click',close);
    return()=>document.removeEventListener('click',close);
  },[foodMenu]);

  useEffect(()=>()=>{if(undoTimer.current)window.clearTimeout(undoTimer.current)},[]);

  function offerUndo(label:string,action:()=>void){
    if(undoTimer.current)window.clearTimeout(undoTimer.current);
    setUndo({label,action});
    undoTimer.current=window.setTimeout(()=>setUndo(null),5000);
  }

  function consumeUndo(){
    if(!undo)return;
    undo.action();
    setUndo(null);
    if(undoTimer.current)window.clearTimeout(undoTimer.current);
  }

  function showActionFeedback(message:string){
    if(feedbackTimer.current)window.clearTimeout(feedbackTimer.current);
    setActionFeedback(message);
    feedbackTimer.current=window.setTimeout(()=>setActionFeedback(null),2200);
  }

  function syncError(message='Não foi possível sincronizar esta alteração.'){
    setAuthMessage(message+' O dado local foi preservado.');
  }

  async function activateHousehold(targetHouseholdId?:string|null,targetUserId=userId,showMessage=false){
    if(!targetUserId)return;
    const request=++authRequest.current;
    setCacheReady(false);
    setHouseholdBusy(true);
    clearTransientUi();
    try{
      const context=await fetchHouseholdContext(targetUserId,targetHouseholdId);
      if(request!==authRequest.current)return;
      setHouseholds(context.households);
      setHouseholdId(context.householdId);
      writeActiveHousehold(targetUserId,context.householdId);
      const fallback=readHouseholdPlaces(targetUserId,context.householdId,context.household.is_personal);
      setPlaces(fallback);
      const pendingOk=await flushPendingSync(targetUserId);
      if(request!==authRequest.current)return;
      if(!pendingOk){
        setSynced(false);
        setAuthMessage('Há alterações aguardando sincronização. Os dados locais desta casa foram preservados.');
        setCacheReady(true);
        return;
      }
      const{data,error}=await supabase.from('locations')
        .select('id,name,subdivisions(id,name,foods(id,name,quantity,unit,expires_on))')
        .eq('household_id',context.householdId)
        .order('created_at');
      if(request!==authRequest.current)return;
      if(error){
        setSynced(false);
        setAuthMessage('Não foi possível sincronizar esta casa agora. Os dados locais foram preservados.');
        setCacheReady(true);
        return;
      }
      const cloudPlaces=mapCloudPlaces(data||[]);
      if(cloudPlaces.length){
        setPlaces(cloudPlaces);
        writeHouseholdPlaces(targetUserId,context.householdId,cloudPlaces);
        clearLegacyCachesIfMatching(targetUserId,cloudPlaces);
        setSynced(true);
      }else if(fallback.length){
        setPlaces(fallback);
        writeHouseholdPlaces(targetUserId,context.householdId,fallback);
        try{
          await uploadLocal(targetUserId,fallback,context.householdId);
          if(request!==authRequest.current)return;
          clearLegacyCachesIfMatching(targetUserId,fallback);
          setSynced(true);
          if(showMessage)setAuthMessage('Casa carregada e estoque sincronizado.');
        }catch{
          if(request!==authRequest.current)return;
          setSynced(false);
          setAuthMessage('Os dados locais desta casa foram preservados, mas ainda não foi possível sincronizá-los.');
        }
      }else{
        setPlaces([]);
        writeHouseholdPlaces(targetUserId,context.householdId,[]);
        setSynced(true);
      }
      setCacheReady(true);
    }catch{
      if(request!==authRequest.current)return;
      setSynced(false);
      setAuthMessage('Não foi possível abrir esta casa. Os dados locais foram preservados.');
      setCacheReady(true);
    }finally{
      if(request===authRequest.current)setHouseholdBusy(false);
    }
  }

  async function renameHousehold(targetId:string,name:string){
    const clean=name.trim();
    const target=households.find(h=>h.id===targetId);
    if(!userId||!target||!clean||clean.length>15)return false;
    setHouseholdBusy(true);
    try{
      const{error}=await supabase.from('households').update({name:clean}).eq('id',targetId);
      if(error)throw error;
      setHouseholds(current=>current.map(h=>h.id===targetId?{...h,name:clean}:h));
      return true;
    }catch{
      setAuthMessage('Não foi possível alterar o nome desta casa. Verifique suas permissões e tente novamente.');
      return false;
    }finally{setHouseholdBusy(false)}
  }

  async function leaveHousehold(targetId:string):Promise<boolean>{
    const target=households.find(h=>h.id===targetId);
    if(!userId||!target||target.is_personal)return false;
    setHouseholdBusy(true);
    try{
      const{error}=await supabase.rpc('leave_household',{target_household_id:targetId});
      if(error)throw error;
      setHouseholdModal(false);
      const personalHouse=households.find(h=>h.is_personal&&h.id!==targetId);
      const nextHouse=households.find(h=>h.id!==targetId);
      await activateHousehold(personalHouse?.id||nextHouse?.id||null,userId,true);
      setAuthMessage('Você saiu da casa compartilhada. Sua conta e seus dados pessoais foram mantidos.');
      return true;
    }catch{
      setAuthMessage('Não foi possível sair desta casa agora. Nenhum dado foi excluído; tente novamente.');
      return false;
    }finally{setHouseholdBusy(false)}
  }

  async function createHousehold(name:string):Promise<boolean>{
    const clean=name.trim();
    if(!userId||!clean||clean.length>15)return false;
    setHouseholdBusy(true);
    try{
      const{data,error}=await supabase.rpc('create_household',{house_name:clean});
      if(error)throw error;
      const newHouseholdId=String(data);
      await activateHousehold(newHouseholdId,userId,true);
      setHouseholdModal(false);
      showActionFeedback('Casa criada. Você pode alternar entre suas casas pelo seletor.');
      return true;
    }catch{
      setAuthMessage('Não foi possível criar a casa agora. Confira o nome e tente novamente.');
      return false;
    }finally{setHouseholdBusy(false)}
  }

  async function createHouseholdInvite(){
    if(!userId||!householdId)return;
    setHouseholdBusy(true);
    setHouseholdInvite(null);
    setHouseholdCopied(false);
    try{
      const{data,error}=await supabase.rpc('create_household_invite',{
        target_household_id:householdId,valid_for_days:7,allowed_uses:10
      });
      if(error)throw error;
      const invite=Array.isArray(data)?data[0]:data;
      if(!invite?.invite_code)throw new Error('O convite não foi retornado.');
      setHouseholdInvite({code:invite.invite_code,expiresAt:invite.invite_expires_at});
      setAuthMessage(null);
    }catch{
      setAuthMessage('Não foi possível gerar o convite. Verifique se você ainda faz parte desta casa e tente novamente.');
    }finally{setHouseholdBusy(false)}
  }

  async function joinHousehold(){
    if(!userId||!householdJoinCode.trim())return;
    setHouseholdBusy(true);
    try{
      const{data,error}=await supabase.rpc('join_household_by_code',{invite_code:householdJoinCode.trim()});
      if(error)throw error;
      setHouseholdJoinCode('');
      setHouseholdInvite(null);
      await activateHousehold(String(data),userId,true);
      setHouseholdModal(false);
    }catch{
      setAuthMessage('Esse convite é inválido, expirou ou atingiu o limite de usos.');
    }finally{setHouseholdBusy(false)}
  }

  async function addRecipeMissing(items:Pick<RecipeIngredient,'name'|'quantity'|'unit'|'measureText'>[]){
    if(!userId||!householdId){
      setAuthMessage('Entre na sua conta para adicionar ingredientes à lista de compras.');
      setAuthModal(true);
      return;
    }
    for(const item of items)await addShoppingItem(item.name,item.quantity,item.unit,'recipe',item.measureText?('Medida da receita: '+item.measureText):undefined);
    setSelected(null);
    setWorkspace('shopping');
    setAuthMessage(items.length+' '+(items.length===1?'ingrediente adicionado':'ingredientes adicionados')+' à lista de compras.');
  }

  async function cookRecipe(recipe:Recipe){
    if(recipe.presenceOnly){
      setCookConfirmRecipe(null);
      setAuthMessage('Receitas externas não descontam o estoque automaticamente, pois as quantidades precisam ser conferidas na fonte.');
      return;
    }
    const pantry:RecipePantryItem[]=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods));
    const statuses=getRecipeIngredientStatuses(recipe,pantry);
    if(statuses.some(status=>status.enough!==true)){
      setCookConfirmRecipe(null);
      setAuthMessage('Ainda faltam ingredientes ou há unidades que não podem ser comparadas com segurança.');
      return;
    }

    const updates=new Map<string,{placeId:string;subId:string;food:Food;quantity:number}>();
    for(const ingredient of recipe.ingredients){
      let remaining=ingredient.quantity;
      const candidates=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods
        .filter(food=>matchesRecipeIngredient(ingredient,food.name)&&!(food.expires_on&&food.expires_on<localDateString()))
        .map(food=>({placeId:place.id,subId:subdivision.id,food}))))
        .sort((a,b)=>(a.food.expires_on||'9999-12-31').localeCompare(b.food.expires_on||'9999-12-31'));
      for(const candidate of candidates){
        if(remaining<=1e-7)break;
        const already=updates.get(candidate.food.id);
        const currentQty=already?.quantity??candidate.food.quantity;
        const available=convertRecipeQuantity(currentQty,candidate.food.unit,ingredient.unit);
        if(available===null||available<=0)continue;
        const consumed=Math.min(available,remaining);
        const consumedInStockUnit=convertRecipeQuantity(consumed,ingredient.unit,candidate.food.unit);
        if(consumedInStockUnit===null)continue;
        updates.set(candidate.food.id,{
          ...candidate,
          quantity:Math.max(0,Number((currentQty-consumedInStockUnit).toFixed(3)))
        });
        remaining-=consumed;
      }
    }

    const updatedPlaces=places.map(place=>({...place,subdivisions:place.subdivisions.map(subdivision=>({...subdivision,foods:subdivision.foods.map(food=>{
      const update=updates.get(food.id);
      return update?{...food,quantity:update.quantity}:food;
    })}))}));
    setPlaces(updatedPlaces);
    setCookConfirmRecipe(null);
    for(const update of updates.values()){
      if(userId){
        const ok=await writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:update.food.id,data:{quantity:update.quantity}});
        if(!ok)syncError('Receita registrada localmente; o estoque será sincronizado quando a conexão voltar.');
      }
      const rule=consumptionRules.find(item=>item.food_id===update.food.id);
      if(userId&&rule?.low_stock_threshold!==null&&rule?.low_stock_threshold!==undefined&&rule.restock_quantity!==null&&rule.restock_quantity!==undefined&&update.quantity<=rule.low_stock_threshold){
        await addShoppingItem(update.food.name,rule.restock_quantity,update.food.unit,'low_stock');
      }
    }
    setAuthMessage('Receita marcada como preparada. O estoque foi atualizado.');
  }

  async function saveRecurringRule(input:{name:string;quantity:number;unit:Unit;frequencyDays:number;nextDueOn:string;id?:string}){
    if(!userId||!householdId){
      setAuthMessage('Entre na sua conta para configurar reposições recorrentes.');
      setAuthModal(true);
      return;
    }
    const name=input.name.trim();
    if(!name||!Number.isFinite(input.quantity)||input.quantity<=0||!Number.isInteger(input.frequencyDays)||input.frequencyDays<1||input.frequencyDays>365)return;
    setRecurringRuleBusy(true);
    const existing=recurringRules.find(rule=>rule.id===input.id);
    const rule:RecurringShoppingRule={
      id:existing?.id||uid(),
      household_id:householdId,
      name,quantity:input.quantity,unit:input.unit,
      frequency_days:input.frequencyDays,
      next_due_on:input.nextDueOn||localDateString(),
      is_active:true,created_by:existing?.created_by||userId
    };
    setRecurringRules(current=>[...current.filter(item=>item.id!==rule.id),rule].sort((a,b)=>a.next_due_on.localeCompare(b.next_due_on)));
    const ok=await writeOrQueue(userId,{userId,table:'recurring_shopping_items',action:existing?'update':'upsert',rowId:rule.id,data:existing?{
      name:rule.name,quantity:rule.quantity,unit:rule.unit,frequency_days:rule.frequency_days,next_due_on:rule.next_due_on,is_active:true
    }:rule as unknown as Record<string,unknown>});
    if(!ok)syncError('Reposição recorrente salva localmente; será sincronizada quando a conexão voltar.');
    else if(rule.next_due_on<=localDateString()){
      void refreshShoppingList(userId,householdId);
      void refreshRecurringRules(userId,householdId);
    }
    setRecurringRuleBusy(false);
  }

  async function toggleRecurringRule(rule:RecurringShoppingRule){
    if(!userId||!householdId)return;
    const isActive=!rule.is_active;
    setRecurringRules(current=>current.map(item=>item.id===rule.id?{...item,is_active:isActive}:item));
    const ok=await writeOrQueue(userId,{userId,table:'recurring_shopping_items',action:'update',rowId:rule.id,data:{is_active:isActive}});
    if(!ok)syncError('Estado da reposição atualizado localmente; será sincronizado quando a conexão voltar.');
  }

  async function deleteRecurringRule(rule:RecurringShoppingRule){
    if(!userId||!householdId)return;
    setRecurringRules(current=>current.filter(item=>item.id!==rule.id));
    const ok=await writeOrQueue(userId,{userId,table:'recurring_shopping_items',action:'delete',rowId:rule.id});
    if(!ok)syncError('Reposição recorrente removida localmente; será sincronizada quando a conexão voltar.');
  }

  async function saveConsumptionRule(foodId:string,daysPerUnit:number){
    if(!userId||!householdId){
      setAuthModal(true);
      setAuthMessage('Entre na sua conta para programar o consumo deste alimento.');
      return;
    }
    const existing=consumptionRules.find(rule=>rule.food_id===foodId);
    const today=localDateString();
    const rule:ConsumptionRule={
      id:existing?.id||uid(),
      household_id:householdId,
      food_id:foodId,
      amount:1,
      period_days:daysPerUnit,
      next_suggestion_on:existing?.next_suggestion_on||addIsoDays(today,daysPerUnit),
      low_stock_threshold:existing?.low_stock_threshold??null,
      restock_quantity:existing?.restock_quantity??null,
      is_active:true,
      created_by:existing?.created_by||userId,
      last_confirmed_at:existing?.last_confirmed_at||null
    };
    setConsumptionRules(current=>[...current.filter(item=>item.food_id!==foodId),rule]);
    setConsumptionRuleModal(null);
    const ok=await writeOrQueue(userId,{
      userId,table:'food_consumption_rules',action:existing?'update':'upsert',
      rowId:rule.id,
      data:existing?{
        amount:1,period_days:daysPerUnit,next_suggestion_on:rule.next_suggestion_on,is_active:true
      }:rule as unknown as Record<string,unknown>
    });
    if(!ok)syncError('Programação salva neste dispositivo; será sincronizada quando a conexão voltar.');
  }

  async function removeConsumptionRule(foodId:string){
    if(!userId)return;
    const rule=consumptionRules.find(item=>item.food_id===foodId);
    if(!rule)return;
    setConsumptionRules(current=>current.filter(item=>item.food_id!==foodId));
    setConsumptionRuleModal(null);
    const ok=await writeOrQueue(userId,{userId,table:'food_consumption_rules',action:'delete',rowId:rule.id});
    if(!ok)syncError('Programação removida localmente; a alteração será sincronizada quando a conexão voltar.');
  }

  async function handleConsumptionSuggestion(rule:ConsumptionRule,confirm:boolean){
    if(!userId||!householdId||rule.household_id!==householdId)return;
    const found=places.flatMap(place=>place.subdivisions.map(subdivision=>({place,subdivision})))
      .map(entry=>({...entry,food:entry.subdivision.foods.find(food=>food.id===rule.food_id)}))
      .find(entry=>entry.food);
    if(!found?.food)return;
    const food=found.food;
    const previousQuantity=food.quantity;
    const amount=confirm?Math.min(previousQuantity,1):0;
    const nextQuantity=confirm?Math.max(0,Number((previousQuantity-amount).toFixed(3))):previousQuantity;
    if(confirm){
      setPlaces(current=>current.map(place=>place.id!==found.place.id?place:{
        ...place,subdivisions:place.subdivisions.map(subdivision=>subdivision.id!==found.subdivision.id?subdivision:{
          ...subdivision,foods:subdivision.foods.map(item=>item.id===food.id?{...item,quantity:nextQuantity}:item)
        })
      }));
      const stockOk=await writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:food.id,data:{quantity:nextQuantity}});
      if(!stockOk)syncError('Consumo registrado localmente; a quantidade será sincronizada quando a conexão voltar.');
    }

    const eventId=uid();
    const event={
      id:eventId,household_id:householdId,food_id:food.id,food_name:food.name,
      event_type:confirm?'confirmed':'skipped',scheduled_for:rule.next_suggestion_on,
      amount,previous_quantity:previousQuantity,new_quantity:nextQuantity,created_by:userId
    };
    const eventOk=await writeOrQueue(userId,{userId,table:'food_consumption_events',action:'insert',rowId:eventId,data:event});
    const nextDate=addIsoDays(localDateString(),confirm?rule.period_days:1);
    const updatedRule={...rule,next_suggestion_on:nextDate,last_confirmed_at:confirm?new Date().toISOString():rule.last_confirmed_at};
    setConsumptionRules(current=>current.map(item=>item.id===rule.id?updatedRule:item));
    const ruleOk=await writeOrQueue(userId,{userId,table:'food_consumption_rules',action:'update',rowId:rule.id,data:{
      next_suggestion_on:nextDate,last_confirmed_at:updatedRule.last_confirmed_at
    }});
    if(!eventOk||!ruleOk)syncError('A revisão foi registrada localmente e será sincronizada quando a conexão voltar.');

    if(confirm&&rule.low_stock_threshold!==null&&rule.restock_quantity!==null&&nextQuantity<=rule.low_stock_threshold){
      await addShoppingItem(food.name,rule.restock_quantity,food.unit,'low_stock');
      setAuthMessage(food.name+' foi adicionado à lista de compras porque o estoque ficou baixo.');
    }else if(confirm){
      setAuthMessage('Consumo de '+food.name+' confirmado. O estoque foi atualizado.');
    }else{
      setAuthMessage('Sugestão de consumo adiada para amanhã.');
    }
  }

  function persistShopping(next:ShoppingItem[],targetHousehold=householdId,targetUser=userId){
    shoppingItemsRef.current=next;
    setShoppingItems(next);
    if(targetUser&&targetHousehold)writeShoppingCache(targetUser,targetHousehold,next);
  }

  async function addShoppingItem(name:string,quantity:number,unit:Unit,source:'manual'|'low_stock'|'recurring'|'recipe'|'meal_plan'='manual',notes?:string){
    const clean=name.trim();
    if(!clean||!Number.isFinite(quantity)||quantity<=0)return;
    if(!userId||!householdId){
      setAuthMessage('Entre na sua conta para usar a lista de compras compartilhada.');
      setAuthModal(true);
      return;
    }
    const currentItems=shoppingItemsRef.current;
    const duplicate=currentItems.find(item=>!item.is_purchased&&searchKey(item.name)===searchKey(clean)&&item.unit===unit);
    if(duplicate){
      const nextQuantity=Number((duplicate.quantity+quantity).toFixed(3));
      const next=currentItems.map(item=>item.id===duplicate.id?{...item,quantity:nextQuantity,source:source==='manual'?item.source:source,...(notes?{notes}:{})}:item);
      persistShopping(next);
      const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'update',rowId:duplicate.id,data:{quantity:nextQuantity,...(source!=='manual'?{source}:{}),...(notes?{notes}:{})}});
      if(!ok)syncError('Quantidade atualizada na lista deste dispositivo; será sincronizada quando a conexão voltar.');
      return;
    }
    const item:ShoppingItem={
      id:uid(),household_id:householdId,name:clean,quantity,unit,
      is_purchased:false,source,created_by:userId,created_at:new Date().toISOString(),...(notes?{notes}:{})
    };
    persistShopping([item,...currentItems]);
    const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'upsert',rowId:item.id,data:item as unknown as Record<string,unknown>});
    if(!ok)syncError('Item adicionado à lista local; será sincronizado quando a conexão voltar.');
  }

  async function toggleShoppingItem(item:ShoppingItem){
    if(!userId||!householdId||item.household_id!==householdId)return;
    const isPurchased=!item.is_purchased;
    const updated:ShoppingItem={
      ...item,
      is_purchased:isPurchased,
      purchased_by:isPurchased?userId:null,
      purchased_at:isPurchased?new Date().toISOString():null
    };
    persistShopping(shoppingItemsRef.current.map(row=>row.id===item.id?updated:row));
    const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'update',rowId:item.id,data:{
      is_purchased:updated.is_purchased,purchased_by:updated.purchased_by,purchased_at:updated.purchased_at
    }});
    if(!ok)syncError('Estado atualizado localmente; será sincronizado quando a conexão voltar.');
    if(isPurchased)setShoppingStockItem(updated);
  }

  async function updateShoppingItem(item:ShoppingItem,quantity:number,unit:Unit){
    if(!userId||!householdId||item.household_id!==householdId||!Number.isFinite(quantity)||quantity<=0)return;
    const updated={...item,quantity:Number(quantity.toFixed(3)),unit};
    persistShopping(shoppingItemsRef.current.map(row=>row.id===item.id?updated:row));
    const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'update',rowId:item.id,data:{quantity:updated.quantity,unit:updated.unit}});
    if(!ok)syncError('Quantidade e unidade atualizadas neste dispositivo; serão sincronizadas quando a conexão voltar.');
  }

  async function deleteShoppingItem(item:ShoppingItem){
    if(!userId||!householdId||item.household_id!==householdId)return;
    persistShopping(shoppingItemsRef.current.filter(row=>row.id!==item.id));
    const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'delete',rowId:item.id});
    if(!ok)syncError('Item removido localmente; a exclusão será sincronizada quando a conexão voltar.');
  }

  async function addPurchasedShoppingToStock(item:ShoppingItem,placeId:string,subId:string,expiresOn:string|null){
    if(!userId||!householdId||item.household_id!==householdId||!item.is_purchased)return;
    const targetPlace=places.find(place=>place.id===placeId);
    const targetSub=targetPlace?.subdivisions.find(subdivision=>subdivision.id===subId);
    if(!targetPlace||!targetSub)return;
    const unit=units.includes(item.unit as Unit)?item.unit as Unit:'unidades';
    const existing=targetSub.foods.find(food=>searchKey(food.name)===searchKey(item.name)&&food.unit===unit&&(food.expires_on||'')===(expiresOn||''));
    let targetFoodId:string|null=null;
    if(existing){
      targetFoodId=existing.id;
      await addToExistingFood(placeId,subId,existing.id,item.quantity,unit);
    }else{
      targetFoodId=await saveFood(placeId,subId,{name:item.name,quantity:item.quantity,unit,expires_on:expiresOn});
    }
    if(!targetFoodId)return;
    const updated=shoppingItemsRef.current.map(row=>row.id===item.id?{...row,linked_food_id:targetFoodId}:row);
    persistShopping(updated);
    const ok=await writeOrQueue(userId,{userId,table:'shopping_items',action:'update',rowId:item.id,data:{linked_food_id:targetFoodId}});
    if(!ok)syncError('O alimento foi adicionado ao estoque. A lista será sincronizada quando a conexão voltar.');
    setShoppingStockItem(null);
  }

  async function handleEmailAuth(mode:'signin'|'signup',email:string,password:string){
    setAuthBusy(true);
    setAuthMessage(null);
    try{
      if(mode==='signup'){
        const{data,error}=await supabase.auth.signUp({email,password,options:{emailRedirectTo:authRedirectUrl()}});
        if(error){setAuthMessage(error.message);return}
        if(!data.session||!data.user){
          setAuthMessage('Conta criada. Verifique seu e-mail para confirmar a conta e depois entre novamente.');
          return;
        }
        setUser(data.user);
        setUserId(data.user.id);
        setRecentFoods(readRecentFoods(data.user.id));
        await activateHousehold(null,data.user.id,true);
        setAuthModal(false);
      }else{
        const{data,error}=await supabase.auth.signInWithPassword({email,password});
        if(error){setAuthMessage(error.message);return}
        if(!data.user){
          setAuthMessage('Não foi possível carregar esta conta. Tente entrar novamente.');
          return;
        }
        setUser(data.user);
        setUserId(data.user.id);
        setRecentFoods(readRecentFoods(data.user.id));
        await activateHousehold(null,data.user.id,true);
        setAuthModal(false);
      }
    }finally{setAuthBusy(false)}
  }

  async function resetPassword(email:string){
    setAuthBusy(true);
    setAuthMessage(null);
    try{
      const{error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:authRedirectUrl()});
      setAuthMessage(error?'Não foi possível enviar o link de recuperação.':'Enviamos um link de recuperação para seu e-mail.');
    }finally{setAuthBusy(false)}
  }

  async function signOut(){
    if(authBusy)return;
    setAuthBusy(true);
    ++authRequest.current;
    try{
      const{error}=await supabase.auth.signOut();
      if(error){setAuthMessage('Não foi possível sair da conta agora.');return}
      setLocalOwner(user?.id||null);
      setCacheReady(true);
      setPlaces(readAnonymousPlaces());
      setUser(null);
      setUserId(null);
      setHouseholds([]);
      setHouseholdId(null);
      setSynced(false);
      setAuthMessage(null);
      showActionFeedback('Você saiu da conta.');
    }finally{setAuthBusy(false)}
  }

  async function deleteAccount(password:string):Promise<string|null>{
     if(!user?.email||user.is_anonymous)return 'Entre em uma conta com e-mail e senha para continuar.';
     setAuthBusy(true);
     setAuthMessage(null);
     try{
       const{error:reauthError}=await supabase.auth.signInWithPassword({email:user.email,password});
       if(reauthError)return 'Não foi possível confirmar sua senha. Confira a senha e tente novamente.';
       const{error}=await supabase.functions.invoke('delete-account');
       if(error)return 'Não foi possível excluir sua conta agora. Seus dados continuam disponíveis. Tente novamente mais tarde.';
       ++authRequest.current;
       await supabase.auth.signOut();
       setLocalOwner(user.id);
       setCacheReady(true);
       setPlaces(readAnonymousPlaces());
       setUser(null);
       setUserId(null);
       setHouseholds([]);
       setHouseholdId(null);
       setSynced(false);
       setDeleteAccountConfirm(false);
       showActionFeedback('Sua conta foi excluída.');
       return null;
     }catch{
       return 'Não foi possível excluir sua conta agora. Seus dados continuam disponíveis. Tente novamente mais tarde.';
     }finally{setAuthBusy(false)}
   }

   async function changeAccountPassword(password:string):Promise<string|null>{
    setAuthBusy(true);
    setAuthMessage(null);
    try{
      const{error}=await supabase.auth.updateUser({password});
      if(error)return 'Não foi possível alterar a senha. '+(error.message||'Tente novamente.');
      setPasswordChangeModal(false);
      showActionFeedback('Senha alterada com sucesso.');
      return null;
    }catch{
      return 'Não foi possível alterar a senha agora. Confira sua conexão e tente novamente.';
    }finally{setAuthBusy(false)}
  }

  async function updatePassword(password:string){
    setAuthBusy(true);
    setAuthMessage(null);
    try{
      const{error}=await supabase.auth.updateUser({password});
      if(error){setAuthMessage(error.message);return}
      setPasswordRecovery(false);
      setAuthMessage('Senha atualizada com sucesso.');
    }finally{setAuthBusy(false)}
  }

  const current=places.find(p=>p.id===selected);
  const sub=current?.subdivisions.find(s=>s.id===selectedSub);
  const total=places.reduce((n,p)=>n+p.subdivisions.reduce((m,s)=>m+s.foods.length,0),0);
  const sortedLocalFoods=useMemo(()=>{
    const query=searchKey(localFoodSearch.trim()).replace(/\\s+/g,' ');
    const words=query.split(' ').filter(Boolean);
    const rank=(name:string)=>{
      if(!query)return 0;
      const normalized=searchKey(name).replace(/\\s+/g,' ').trim();
      if(normalized===query)return 0;
      if(normalized.startsWith(query))return 1;
      if(normalized.split(/[^a-z0-9]+/).some(word=>word.startsWith(query)))return 2;
      if(words.every(word=>normalized.split(/[^a-z0-9]+/).some(part=>part.startsWith(word))))return 3;
      if(normalized.includes(query))return 4;
      return -1;
    };
    const items=[...(sub?.foods||[])].filter(food=>rank(food.name)>=0);
    return items.sort((a,b)=>{
      if(query){
        const relevance=rank(a.name)-rank(b.name);
        if(relevance)return relevance;
      }
      if(foodSort==='expiry'){
        if(!a.expires_on&&!b.expires_on)return a.name.localeCompare(b.name,'pt-BR');
        if(!a.expires_on)return 1;
        if(!b.expires_on)return -1;
        return a.expires_on.localeCompare(b.expires_on)||a.name.localeCompare(b.name,'pt-BR');
      }
      if(foodSort==='quantity-asc')return a.quantity-b.quantity||a.name.localeCompare(b.name,'pt-BR');
      if(foodSort==='quantity-desc')return b.quantity-a.quantity||a.name.localeCompare(b.name,'pt-BR');
      return a.name.localeCompare(b.name,'pt-BR');
    });
  },[sub,foodSort,localFoodSearch]);
  const reportFoods=useMemo(()=>{
    const query=searchKey(reportSearch.trim());
    const items=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods.map(food=>({
      ...food,placeName:place.name,placeId:place.id,subId:subdivision.id
    })))).filter(food=>(reportLocation==='all'||food.placeId===reportLocation)&&(!query||searchKey(food.name).includes(query)));
    return items.sort((a,b)=>{
      if(reportSort==='expiry'){
        if(!a.expires_on&&!b.expires_on)return a.name.localeCompare(b.name,'pt-BR');
        if(!a.expires_on)return 1;
        if(!b.expires_on)return -1;
        return a.expires_on.localeCompare(b.expires_on)||a.name.localeCompare(b.name,'pt-BR');
      }
      if(reportSort==='location')return a.placeName.localeCompare(b.placeName,'pt-BR')||a.name.localeCompare(b.name,'pt-BR');
      if(reportSort==='quantity-asc')return a.quantity-b.quantity||a.name.localeCompare(b.name,'pt-BR');
      if(reportSort==='quantity-desc')return b.quantity-a.quantity||a.name.localeCompare(b.name,'pt-BR');
      return a.name.localeCompare(b.name,'pt-BR');
    });
  },[places,reportSearch,reportLocation,reportSort]);
  const results=useMemo(()=>{
    const q=searchKey(search.trim());
    if(!q)return[];
    const found=places.flatMap(p=>p.subdivisions.flatMap(s=>s.foods.filter(f=>searchKey(f.name).includes(q)).map(f=>({...f,place:p.name,sub:s.name,placeId:p.id,subId:s.id}))));
    return found.sort((a,b)=>{
      const an=searchKey(a.name),bn=searchKey(b.name);
      const ar=an===q?0:an.startsWith(q)?1:2;
      const br=bn===q?0:bn.startsWith(q)?1:2;
      return ar-br||an.localeCompare(bn,'pt-BR');
    });
  },[search,places]);

  const todayISO=localDateString();
  const expiringFoods=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods
    .filter(food=>!!food.expires_on&&daysUntilExpiry(food.expires_on!)<=7)
    .map(food=>({food,place,subdivision,days:daysUntilExpiry(food.expires_on!)}))))
    .sort((a,b)=>a.days-b.days);
  const dueConsumptionSuggestions=consumptionRules.filter(rule=>rule.is_active&&rule.next_suggestion_on<=todayISO&&!handledNotifications.includes('consumption:'+rule.id+':'+rule.next_suggestion_on))
    .flatMap(rule=>{
      for(const place of places){
        for(const subdivision of place.subdivisions){
          const food=subdivision.foods.find(item=>item.id===rule.food_id);
          if(food&&food.quantity>0)return[{rule,food,place,subdivision}];
        }
      }
      return[];
    });
  const expiredNotifications=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods
    .filter(food=>food.quantity>0&&!!food.expires_on&&food.expires_on<=todayISO&&!handledNotifications.includes('expiry:'+food.id+':'+food.expires_on))
    .map(food=>({food,place,subdivision,key:'expiry:'+food.id+':'+food.expires_on}))));
  const notificationCount=expiredNotifications.length+dueConsumptionSuggestions.length;
  function handleNotification(key:string){setHandledNotifications(current=>current.includes(key)?current:[...current,key]);}
  function foodHasAlert(food:Food){
    const expired=food.quantity>0&&!!food.expires_on&&food.expires_on<=todayISO&&!handledNotifications.includes('expiry:'+food.id+':'+food.expires_on);
    const due=dueConsumptionSuggestions.some(item=>item.food.id===food.id);
    return expired||due;
  }

  async function saveFood(placeId:string,subId:string,data:Omit<Food,'id'>,id?:string):Promise<string|null>{
    if(!userId){promptAccount('adicionar alimentos ao estoque');return null;}
    const cleanName=data.name.trim();
    if(!cleanName||!places.some(p=>p.id===placeId&&p.subdivisions.some(s=>s.id===subId)))return null;
    const safeQuantity=Math.max(0,Number.isFinite(data.quantity)?Number(data.quantity):0);
    const safeUnit=units.includes(data.unit)?data.unit:'unidades';
    const food={name:cleanName,quantity:safeQuantity,unit:safeUnit,expires_on:data.expires_on||null,id:id||uid()};
    const snapshot=places;
    const next=places.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id!==subId?s:{...s,foods:id?s.foods.map(f=>f.id===id?food:f):[...s.foods,food]})});
    setPlaces(next);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'foods',action:'upsert',rowId:food.id,data:{id:food.id,user_id:userId,subdivision_id:subId,name:food.name,quantity:food.quantity,unit:food.unit,expires_on:food.expires_on}});
      if(!ok)syncError('Alimento salvo neste dispositivo. Ele será sincronizado quando a conexão voltar.');
    }
    rememberFood(food.name,food.unit);
    setFoodModal(null);
    return food.id;
  }

  async function addToExistingFood(placeId:string,subId:string,existingId:string,amount:number,unit:Unit){
    const existing=places.find(p=>p.id===placeId)?.subdivisions.find(s=>s.id===subId)?.foods.find(f=>f.id===existingId);
    if(!existing||existing.unit!==unit||amount<=0)return;
    const nextQty=Number((existing.quantity+amount).toFixed(3));
    const snapshot=places;
    const next=places.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id!==subId?s:{...s,foods:s.foods.map(f=>f.id===existingId?{...f,quantity:nextQty}:f)})});
    setPlaces(next);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:existingId,data:{quantity:nextQty}});
      if(!ok)syncError('Quantidade salva neste dispositivo. Ela será sincronizada quando a conexão voltar.');
    }
    setFoodModal(null);
    setAuthMessage(null);
  }

  async function removeFood(placeId:string,subId:string,id:string){
    if(!userId){promptAccount('editar seu estoque');return;}
    const snapshot=places;
    const removed=places.find(p=>p.id===placeId)?.subdivisions.find(s=>s.id===subId)?.foods.find(f=>f.id===id);
    if(!removed)return;
    const next=places.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id!==subId?s:{...s,foods:s.foods.filter(f=>f.id!==id)})});
    setPlaces(next);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'foods',action:'delete',rowId:id});
      if(!ok)syncError('Alimento removido neste dispositivo. A exclusão será sincronizada quando a conexão voltar.');
    }
    setFoodMenu(null);
    offerUndo('Alimento removido',()=>{
      setPlaces(ps=>ps.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id!==subId?s:{...s,foods:s.foods.some(f=>f.id===removed.id)?s.foods:[...s.foods,removed]})}));
      if(userId)void writeOrQueue(userId,{userId,table:'foods',action:'upsert',rowId:removed.id,data:{id:removed.id,user_id:userId,subdivision_id:subId,name:removed.name,quantity:removed.quantity,unit:removed.unit,expires_on:removed.expires_on||null}}).then(ok=>{if(!ok)syncError('O alimento foi restaurado neste dispositivo e será sincronizado quando a conexão voltar.')});
    });
  }

  async function changeQty(placeId:string,subId:string,id:string,delta:number){
    const food=places.find(p=>p.id===placeId)?.subdivisions.find(s=>s.id===subId)?.foods.find(f=>f.id===id);
    if(!food)return;
    const step=quantityStep(food.unit);
    const nextQty=Math.max(0,Number((food.quantity+(delta*step)).toFixed(3)));
    if(nextQty===food.quantity)return;
    if(nextQty===0){setZeroQtyConfirm({placeId,subId,food});return;}
    const snapshot=places;
    const next=places.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id!==subId?s:{...s,foods:s.foods.map(f=>f.id===id?{...f,quantity:nextQty}:f)})});
    setPlaces(next);
    showActionFeedback(`${food.name}: quantidade atualizada`);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:id,data:{quantity:nextQty}});
      if(!ok)syncError('Quantidade salva neste dispositivo. Ela será sincronizada quando a conexão voltar.');
    }
  }

  async function moveFood(fromPlaceId:string,fromSubId:string,foodId:string,toPlaceId:string,toSubId:string){
    if(!userId){promptAccount('mover alimentos entre locais');return;}
    if(fromSubId===toSubId)return;
    const sourcePlace=places.find(p=>p.id===fromPlaceId);
    const sourceSub=sourcePlace?.subdivisions.find(s=>s.id===fromSubId);
    const food=sourceSub?.foods.find(f=>f.id===foodId);
    if(!food)return;
    const snapshot=places;
    const next=places.map(p=>{
      if(p.id===fromPlaceId){
        return{...p,subdivisions:p.subdivisions.map(s=>s.id===fromSubId?{...s,foods:s.foods.filter(f=>f.id!==foodId)}:s)};
      }
      return p;
    }).map(p=>{
      if(p.id===toPlaceId){
        return{...p,subdivisions:p.subdivisions.map(s=>s.id===toSubId?{...s,foods:[...s.foods,food]}:s)};
      }
      return p;
    });
    setPlaces(next);
    setMoveModal(null);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:foodId,data:{subdivision_id:toSubId}});
      if(!ok)syncError('Alimento movido neste dispositivo. A mudança será sincronizada quando a conexão voltar.');
    }
    const destinationPlace=places.find(p=>p.id===toPlaceId);
    const destinationSub=destinationPlace?.subdivisions.find(s=>s.id===toSubId);
    offerUndo('Alimento movido',()=>{
      setPlaces(ps=>ps.map(p=>{
        if(p.id===toPlaceId)return{...p,subdivisions:p.subdivisions.map(s=>s.id===toSubId?{...s,foods:s.foods.filter(f=>f.id!==foodId)}:s)};
        if(p.id===fromPlaceId)return{...p,subdivisions:p.subdivisions.map(s=>s.id===fromSubId?{...s,foods:s.foods.some(f=>f.id===foodId)?s.foods:[...s.foods,food]}:s)};
        return p;
      }));
      if(userId)void writeOrQueue(userId,{userId,table:'foods',action:'update',rowId:foodId,data:{subdivision_id:fromSubId}}).then(ok=>{if(!ok)syncError('O alimento foi restaurado neste dispositivo e será sincronizado quando a conexão voltar.')});
    });
    setFoodMenu(null);
    if(destinationPlace&&destinationSub)setAuthMessage(null);
  }

  async function savePlace(name:string,id?:string):Promise<boolean>{
    if(!userId){promptAccount('criar ou alterar locais de armazenamento');return false;}
    const clean=name.trim();
    if(!clean)return false;
    const duplicate=places.some(p=>p.id!==id&&searchKey(p.name)===searchKey(clean));
    if(duplicate){setAuthMessage('Já existe um local com esse nome.');return false;}
    const placeId=id||uid();
    const newSub=id?null:makeSub('Geral');
    const snapshot=places;
    const next=id?places.map(p=>p.id===id?{...p,name:clean}:p):[...places,{id:placeId,name:clean,subdivisions:[newSub!]}];
    setPlaces(next);
    if(userId){
      const locationOk=await writeOrQueue(userId,{userId,table:'locations',action:'upsert',rowId:placeId,data:{id:placeId,user_id:userId,name:clean,...(householdId?{household_id:householdId}:{})}});
      if(!locationOk)syncError('Local salvo neste dispositivo. Ele será sincronizado quando a conexão voltar.');
      if(newSub){
        const subOk=await writeOrQueue(userId,{userId,table:'subdivisions',action:'upsert',rowId:newSub.id,data:{id:newSub.id,user_id:userId,location_id:placeId,name:newSub.name}});
        if(!subOk)syncError('Local salvo neste dispositivo. O local será sincronizado quando a conexão voltar.');
      }
    }
    setPlaceModal(false);
    setPlaceToEdit(null);
    return true;
  }

  async function removePlace(id:string):Promise<boolean>{
    if(!userId){promptAccount('alterar seus locais de armazenamento');return false;}
    const removed=places.find(p=>p.id===id);
    if(!removed)return false;
    const snapshot=places;
    const index=places.findIndex(p=>p.id===id);
    setPlaces(ps=>ps.filter(p=>p.id!==id));
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'locations',action:'delete',rowId:id});
      if(!ok)syncError('Local removido neste dispositivo. A exclusão será sincronizada quando a conexão voltar.');
    }
    if(selected===id){setSelected(null);setSelectedSub(null)}
    offerUndo('Local removido',()=>{
      setPlaces(ps=>{
        if(ps.some(p=>p.id===removed.id))return ps;
        const next=[...ps];
        next.splice(Math.min(index,next.length),0,removed);
        return next;
      });
      if(userId){
        for(const p of [removed]){
          void writeOrQueue(userId,{userId,table:'locations',action:'upsert',rowId:p.id,data:{id:p.id,user_id:userId,name:p.name,...(householdId?{household_id:householdId}:{})}}).then(async ok=>{
            if(!ok){syncError('O local foi restaurado neste dispositivo e será sincronizado quando a conexão voltar.');return}
            for(const s of p.subdivisions){
              const subOk=await writeOrQueue(userId,{userId,table:'subdivisions',action:'upsert',rowId:s.id,data:{id:s.id,user_id:userId,location_id:p.id,name:s.name}});
              if(!subOk)return;
              for(const f of s.foods)await writeOrQueue(userId,{userId,table:'foods',action:'upsert',rowId:f.id,data:{id:f.id,user_id:userId,subdivision_id:s.id,name:f.name,quantity:f.quantity,unit:f.unit,expires_on:f.expires_on||null}});
            }
          });
        }
      }
    });
    return true;
  }

  async function saveSub(placeId:string,name:string,id?:string):Promise<boolean>{
    if(!userId){promptAccount('organizar seus locais');return false;}
    const clean=name.trim();
    if(!clean)return false;
    const place=places.find(p=>p.id===placeId);
    if(!place)return false;
    const duplicate=place.subdivisions.some(s=>s.id!==id&&searchKey(s.name)===searchKey(clean));
    if(duplicate){setAuthMessage('Já existe uma divisão com esse nome neste local.');return false;}
    const subId=id||uid();
    const snapshot=places;
    const next=id?places.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.map(s=>s.id===id?{...s,name:clean}:s)}):places.map(p=>p.id===placeId?{...p,subdivisions:[...p.subdivisions,{id:subId,name:clean,foods:[]}]}:p);
    setPlaces(next);
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'subdivisions',action:'upsert',rowId:subId,data:{id:subId,user_id:userId,location_id:placeId,name:clean}});
      if(!ok)syncError('Divisão salva neste dispositivo. Ela será sincronizada quando a conexão voltar.');
    }
    setSubModal(null);
    return true;
  }

  async function removeSub(placeId:string,id:string):Promise<boolean>{
    if(!userId){promptAccount('alterar a organização dos seus locais');return false;}
    const removed=places.find(p=>p.id===placeId)?.subdivisions.find(s=>s.id===id);
    if(!removed)return false;
    const snapshot=places;
    const index=places.find(p=>p.id===placeId)?.subdivisions.findIndex(s=>s.id===id)??-1;
    setPlaces(ps=>ps.map(p=>p.id!==placeId?p:{...p,subdivisions:p.subdivisions.filter(s=>s.id!==id)}));
    if(userId){
      const ok=await writeOrQueue(userId,{userId,table:'subdivisions',action:'delete',rowId:id});
      if(!ok)syncError('Divisão removida neste dispositivo. A exclusão será sincronizada quando a conexão voltar.');
    }
    if(selectedSub===id)setSelectedSub(null);
    offerUndo('Divisão removida',()=>{
      setPlaces(ps=>ps.map(p=>{
        if(p.id!==placeId||p.subdivisions.some(s=>s.id===removed.id))return p;
        const next=[...p.subdivisions];
        next.splice(Math.min(Math.max(index,0),next.length),0,removed);
        return{...p,subdivisions:next};
      }));
      if(userId)void writeOrQueue(userId,{userId,table:'subdivisions',action:'upsert',rowId:removed.id,data:{id:removed.id,user_id:userId,location_id:placeId,name:removed.name}}).then(ok=>{if(!ok)syncError('A divisão foi restaurada neste dispositivo e será sincronizada quando a conexão voltar.')});
    });
    return true;
  }

  function openPlace(id:string){
    setLocalFoodSearch('');
    setSelected(id);
    const p=places.find(x=>x.id===id);
    setSelectedSub(p?.subdivisions[0]?.id||null);
  }

  function openSearchResult(placeId:string,subId:string){
    setSearch('');
    setLocalFoodSearch('');
    setSelected(placeId);
    setSelectedSub(subId);
  }

  function promptAccount(action:string){
    setAuthMessage('Crie uma conta gratuita para '+action+'. Seus locais de exemplo continuarão disponíveis.');
    setAuthModal(true);
  }

  function openAddFoodFromHome(){
    if(!userId){promptAccount('adicionar alimentos ao estoque');return;}
    if(!places.length){setPlaceToEdit(null);setPlaceModal(true);return;}
    setFoodModal({place:'',sub:''});
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo" aria-hidden="true"><svg viewBox="0 0 498 476" role="img" preserveAspectRatio="xMidYMid meet"><path d="M 408 42.750 C 382.302 52.669, 343.116 56.005, 216.500 59.054 C 173.822 60.081, 161.061 61.093, 148 64.487 C 121.466 71.382, 97.957 86.771, 82.289 107.500 C 64.028 131.660, 55.970 157.065, 56.020 190.322 C 56.059 217.043, 60.799 239.933, 69.304 254.475 C 82.460 276.970, 98.187 288.790, 124.968 296.308 C 132.427 298.402, 133.851 298.427, 272.167 298.961 C 348.984 299.257, 412.128 299.794, 412.488 300.154 C 413.931 301.598, 405.297 316.505, 399.200 323.096 C 387.402 335.849, 376.821 342.064, 358.500 347.002 C 341.524 351.577, 329.429 351.935, 190.905 351.969 L 61.310 352 59.414 354.095 C 57.607 356.091, 57.528 358.205, 57.734 398.784 C 57.922 435.852, 58.152 441.581, 59.510 442.939 C 60.887 444.317, 69.919 444.559, 136.546 445 C 237.244 445.667, 310.565 444.732, 318 442.685 C 324.717 440.836, 332.986 438.342, 339 436.352 C 352.666 431.829, 376.892 415.462, 387.099 403.855 C 396.503 393.162, 405.953 378.239, 410.865 366.328 C 417.041 351.350, 420.798 327.982, 419.643 311.721 C 418.178 291.081, 417.900 288.296, 416.831 283.500 C 414.096 271.228, 408.388 257.934, 402.660 250.500 C 396.961 243.102, 383.546 229.814, 378 226.074 C 366.358 218.224, 353.055 213.154, 336.500 210.259 C 327.358 208.661, 315.902 208.505, 203 208.440 C 65.265 208.361, 68 208.390, 68 206.989 C 68 205.147, 72.313 196.583, 76.053 190.999 C 85.315 177.168, 104.890 164.690, 125.489 159.488 C 146.724 154.124, 159.658 153.239, 235.500 151.957 C 288.064 151.069, 297.871 150.360, 316 146.138 C 337.163 141.210, 358.682 129.201, 376.610 112.313 C 390.381 99.342, 407.120 72.909, 413.856 53.500 C 416.232 46.651, 416.968 40.829, 415.500 40.479 C 414.950 40.348, 411.575 41.370, 408 42.750"/></svg></div>
          <div><h1>ShelfSpace</h1><span>Sua casa, organizada.</span></div>
        </div>
        <div className="header-actions">
          {userId&&households.length>1&&<button type="button" className="household-switch-button" onClick={()=>setHouseholdModal(true)} aria-label={'Alternar casa. Casa ativa: '+(households.find(h=>h.id===householdId)?.name||'Casa')} title="Alternar casa"><Home size={16}/><span>{households.find(h=>h.id===householdId)?.name||'Casa'}</span><ChevronDown size={14}/></button>}
          <button className={'notification-bell '+(notificationCenterOpen?'active':'')} onClick={()=>setNotificationCenterOpen(open=>!open)} aria-label={'Notificações: '+notificationCount+' pendentes'} title="Notificações">
            <Bell size={19}/>{notificationCount>0&&<span className="notification-count">{notificationCount>99?'99+':notificationCount}</span>}
          </button>
        </div>
      </header>

      <main>
        {notificationCenterOpen&&<section className="notification-center" aria-label="Central de notificações">
          <div className="notification-center-head"><div><p className="eyebrow">CENTRAL DE ALERTAS</p><h3>Notificações</h3><p>{notificationCount?`${notificationCount} ${notificationCount===1?'item precisa':'itens precisam'} da sua atenção`:'Tudo em dia por aqui.'}</p></div><button className="notification-close" onClick={()=>setNotificationCenterOpen(false)} aria-label="Fechar notificações"><X size={17}/></button></div>
          {notificationCount===0?<div className="notification-empty"><Check size={19}/><span>Nenhuma decisão pendente.</span></div>:<div className="notification-list">
            {expiredNotifications.map(({food,place,subdivision,key})=><article className="notification-item expiry-notification" key={key}><span className="notification-dot expiry-dot"/><div className="notification-copy"><strong>{food.name} atingiu a validade</strong><small>{place.name} · validade {food.expires_on?.split('-').reverse().join('/')}</small><p>Deseja retirar do estoque?</p></div><div className="notification-actions"><button className="notification-remove" onClick={()=>void removeFood(place.id,subdivision.id,food.id)}>Retirar</button><button onClick={()=>handleNotification(key)}>Manter</button></div></article>)}
            {dueConsumptionSuggestions.map(({rule,food,place})=><article className="notification-item" key={'consumption:'+rule.id+':'+rule.next_suggestion_on}><span className="notification-dot consumption-dot"/><div className="notification-copy"><strong>{food.name} atingiu o consumo previsto</strong><small>{place.name} · 1 unidade a cada {rule.period_days} dias</small><p>Consumiu uma unidade? Estoque atual: {formatQuantity(food.quantity,food.unit)}.</p></div><div className="notification-actions"><button className="notification-remove" onClick={()=>void handleConsumptionSuggestion(rule,true)}>Atualizar estoque</button><button onClick={()=>void handleConsumptionSuggestion(rule,false)}>Adiar</button></div></article>)}
          </div>}
        </section>}
        {authMessage&&<div className="auth-note" role="status" aria-live="polite">{authMessage}</div>}


        {selected?(
          <section>
            <button className="back" onClick={()=>{setSelected(null);setSelectedSub(null)}}>← Todos os locais</button>

            <div className="location-hero">
              <div className="location-identity">
                <div className="location-icon" aria-hidden="true"><Box size={20}/></div>
                <div>
                  <p className="eyebrow">LOCAL</p>
                  <h2>{current?.name}</h2>
                  <p>
                    {current?.subdivisions.reduce((n,s)=>n+s.foods.length,0)||0}{' '}
                    {current?.subdivisions.reduce((n,s)=>n+s.foods.length,0)===1?'alimento':'alimentos'}{' '}
                    <span className="sync-status">{!online?'Sem internet · dados locais':synced?'Sincronizado':userId?'Sincronização pendente':'Somente neste dispositivo'}</span>{userId&&online&&!synced&&<button className="sync-retry" type="button" onClick={()=>{void refreshCloud(userId);void refreshShoppingList(userId,householdId);void refreshRecurringRules(userId,householdId);void refreshConsumptionRules(userId,householdId)}}>Tentar sincronizar</button>}
                  </p>
                </div>
              </div>
              <button className="primary location-add" onClick={()=>selectedSub&&setFoodModal({place:selected,sub:selectedSub})} disabled={!selectedSub}>
                <Plus size={18}/> Adicionar alimento
              </button>
            </div>

            {selectedSub&&sub?(
              <>
                <div className="local-inventory-tools">
                  <div className="local-food-search">
                    <Search size={17}/>
                    <input aria-label="Buscar alimento neste local" value={localFoodSearch} onChange={e=>setLocalFoodSearch(e.target.value)} placeholder="Buscar neste local..."/>
                    {localFoodSearch&&<button type="button" onClick={()=>setLocalFoodSearch('')} aria-label="Limpar busca local"><X size={16}/></button>}
                  </div>
                  <div className="inventory-sort-bar">
                    <span><ArrowDownUp size={15}/> Ordenar alimentos</span>
                    <select aria-label="Ordenar alimentos deste local" value={foodSort} onChange={e=>setFoodSort(e.target.value as typeof foodSort)}>
                      <option value="name">Alfabética (A–Z)</option>
                      <option value="expiry">Validade (mais próxima)</option>
                      <option value="quantity-asc">Quantidade (menor primeiro)</option>
                      <option value="quantity-desc">Quantidade (maior primeiro)</option>
                    </select>
                  </div>
                </div>
                {sortedLocalFoods.length?(
                  <div className="food-list">
                    {sortedLocalFoods.map(f=>(
                      <div className={'food '+(f.quantity===0?'out-of-stock':'')+(foodHasAlert(f)?' has-notification':'')} key={f.id}>
                        
                        <div className="food-name">
                          <strong>{f.name}</strong>
                          <span>{f.quantity===0?'Sem estoque · ':''}{f.unit}</span>
                          {f.expires_on&&<small className={'expiry-label '+(daysUntilExpiry(f.expires_on)<0?'expired':daysUntilExpiry(f.expires_on)<=3?'urgent':'')}>{expiryCaption(f.expires_on)}</small>}
                          {dueConsumptionSuggestions.some(item=>item.food.id===f.id)&&<small className="consumption-due-label">Consumo previsto para hoje</small>}
                        </div>
                        {f.quantity===0&&<button className="restock-shortcut" onClick={()=>setShoppingAddFood(f)} title={'Adicionar '+f.name+' à lista de compras'}><ShoppingCart size={15}/><span>Comprar</span></button>}
                        <div className="qty">
                          <button disabled={f.quantity===0} onClick={()=>changeQty(selected,selectedSub,f.id,-1)} aria-label={'Diminuir '+f.name}>
                            <Minus size={15}/>
                          </button>
                          <b>{f.quantity}</b>
                          {f.unit!=='unidades'&&<span className="qty-unit" aria-hidden="true">{f.unit}</span>}
                          <button onClick={()=>changeQty(selected,selectedSub,f.id,1)} aria-label={'Aumentar '+f.name}>
                            <Plus size={15}/>
                          </button>
                        </div>
                        {foodHasAlert(f)&&<button className="food-alert-indicator" onClick={()=>setNotificationCenterOpen(true)} aria-label={'Ver notificação de '+f.name} title="Este item tem uma notificação"><span/></button>}
                        <div className="food-actions">
                          <button className="small action-trigger" title="Mais ações" aria-label={'Mais ações para '+f.name} onClick={e=>{e.stopPropagation();setFoodMenu(foodMenu===f.id?null:f.id)}}>
                            <MoreHorizontal size={18}/>
                          </button>
                          {foodMenu===f.id&&(
                            <div className="action-menu" onClick={e=>e.stopPropagation()}>
                              <button onClick={()=>{setFoodModal({place:selected,sub:selectedSub,food:f});setFoodMenu(null)}}><Edit3 size={16}/> Editar</button>
                              <button onClick={()=>{setShoppingAddFood(f);setFoodMenu(null)}}><ShoppingCart size={16}/> Adicionar à lista de compras</button>
                              <button onClick={()=>{setMoveModal({place:selected,sub:selectedSub,food:f});setFoodMenu(null)}}><MoveRight size={16}/> Mover para...</button>
                              <button onClick={()=>{setConsumptionRuleModal({foodId:f.id});setFoodMenu(null)}}><CalendarClock size={16}/> {consumptionRules.some(rule=>rule.food_id===f.id)?'Editar consumo previsto':'Programar consumo'}</button>
                              <button className="danger" onClick={()=>removeFood(selected,selectedSub,f.id)}><Trash2 size={16}/> Excluir</button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ):(
                  <Empty
                    title={localFoodSearch?'Nenhum alimento encontrado':'Nenhum alimento neste local'}
                    text={localFoodSearch?'Tente outro nome ou limpe a busca para ver todos os alimentos deste local.':'Adicione os alimentos que ficam neste local.'}
                    action={localFoodSearch?()=>setLocalFoodSearch(''):()=>setFoodModal({place:selected,sub:selectedSub})}
                    actionLabel={localFoodSearch?'Limpar busca':'Adicionar alimento'}
                  />
                )}
              </>
            ):null}
          </section>
        ):workspace==='shopping'?(
          <ShoppingPage
            places={places}
            items={shoppingItems}
            loading={shoppingLoading}
            signedIn={!!userId&&!!householdId}
            recurringRules={recurringRules}
            recurringBusy={recurringRuleBusy}
            onAdd={addShoppingItem}
            onToggle={toggleShoppingItem}
            onDelete={deleteShoppingItem}
            onEdit={updateShoppingItem}
            onStock={item=>setShoppingStockItem(item)}
            onSignIn={()=>setAuthModal(true)}
            onSaveRecurring={saveRecurringRule}
            onToggleRecurring={toggleRecurringRule}
            onDeleteRecurring={deleteRecurringRule}
          />
        ):workspace==='settings'?(
          <section className="settings-page">
            <div className="hero settings-hero">
              <div className="hero-copy">
                <p className="eyebrow">PREFERÊNCIAS</p>
                <h2>Configurações</h2>
                <p>Gerencie sua conta, sua casa e a organização do ShelfSpace.</p>
              </div>
            </div>
            <div className="settings-account-card">
              <div className="settings-avatar"><Home size={22}/></div>
              <div className="settings-account-copy">
                <strong>{user&&!user.is_anonymous?(user.email||'Sua conta'):'Use o ShelfSpace em todos os seus dispositivos'}</strong>
                <span>{user&&!user.is_anonymous?'Conta conectada':'Entre ou crie uma conta para sincronizar seus dados'}</span>
              </div>
              <button className="settings-action-button" onClick={user&&!user.is_anonymous?()=>setSignOutConfirm(true):()=>setAuthModal(true)} disabled={authBusy}>{user&&!user.is_anonymous?'Sair':'Entrar'} <ChevronRight size={16}/></button>
            </div>
            {user&&!user.is_anonymous&&<div className="settings-group">
              <p className="settings-group-label">SEGURANÇA DA CONTA</p>
              <button className="settings-row" onClick={()=>{setAuthMessage(null);setPasswordChangeModal(true)}}><span className="settings-row-icon"><LockKeyhole size={19}/></span><span className="settings-row-copy"><strong>Alterar senha</strong><small>Atualize a senha usada para entrar no ShelfSpace</small></span><ChevronRight size={17}/></button>
              <button className="settings-row danger" onClick={()=>setDeleteAccountConfirm(true)}><span className="settings-row-icon"><Trash2 size={19}/></span><span className="settings-row-copy"><strong>Excluir minha conta</strong><small>Apague sua conta permanentemente</small></span><ChevronRight size={17}/></button>
            </div>}
            <div className="settings-group">
              <p className="settings-group-label">SUA CASA</p>
              {userId&&<button className="settings-row" onClick={()=>setHouseholdModal(true)}><span className="settings-row-icon"><Users size={19}/></span><span className="settings-row-copy"><strong>Família e compartilhamento</strong><small>{households.find(h=>h.id===householdId)?.name||'Convide pessoas para compartilhar o estoque'}</small></span><ChevronRight size={17}/></button>}
              <button className="settings-row" onClick={()=>{if(!userId){promptAccount('criar e alterar locais de armazenamento');return;}setPlaceToEdit(null);setPlaceModal(true)}}><span className="settings-row-icon"><Box size={19}/></span><span className="settings-row-copy"><strong>Locais de armazenamento</strong><small>{userId?'Gerencie geladeira, freezer, despensa e outros locais':'Crie uma conta para personalizar seus locais'}</small></span><ChevronRight size={17}/></button>
              <button className="settings-row" onClick={()=>{if(!userId){promptAccount('adicionar alimentos ao estoque');return;}setImportModal(true)}}><span className="settings-row-icon"><Copy size={19}/></span><span className="settings-row-copy"><strong>Importar alimentos</strong><small>{userId?'Adicione uma lista ao seu estoque':'Crie uma conta para importar sua lista'}</small></span><ChevronRight size={17}/></button>
            </div>
            <div className="settings-group">
              <p className="settings-group-label">APLICATIVO</p>
              <button className="settings-row" onClick={()=>{setNotificationCenterOpen(true);setWorkspace('inventory');setSelected(null);setSelectedSub(null)}}><span className="settings-row-icon"><Bell size={19}/></span><span className="settings-row-copy"><strong>Notificações</strong><small>{notificationCount?notificationCount+' alertas precisam da sua atenção':'Alertas de validade e consumo'}</small></span><ChevronRight size={17}/></button>
            </div>
            <p className="settings-footer">ShelfSpace · Sua casa, organizada.</p>
          </section>
        ):workspace==='recipes'?(
          <RecipePage places={places} onAddMissing={addRecipeMissing} onCook={recipe=>setCookConfirmRecipe(recipe)}/>
        ):workspace==='report'?(
          <section className="inventory-report">
            <div className="hero report-hero">
              <div className="hero-copy">
                <p className="eyebrow">VISÃO GERAL</p>
                <h2>Estoque</h2>
                <p>Seus alimentos, organizados por local e validade.</p>
              </div>
              <p className="report-total-inline"><strong>{reportFoods.length}</strong> {reportFoods.length===1?'alimento':'alimentos'} <span>{reportSearch||reportLocation!=='all'?'encontrados':'cadastrados'}</span></p>
            </div>
            <div className="report-filters">
              <label className="report-search"><Search size={18}/><input value={reportSearch} onChange={e=>setReportSearch(e.target.value)} placeholder="Buscar alimento..." aria-label="Buscar alimento no estoque"/></label>
              <label className="report-location-filter"><span>Local</span><select value={reportLocation} onChange={e=>setReportLocation(e.target.value)}><option value="all">Todos os locais</option>{places.map(place=><option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
              <label className="report-sort-filter"><span>Ordenar por</span><select value={reportSort} onChange={e=>setReportSort(e.target.value as typeof reportSort)} aria-label="Ordenar estoque"><option value="name">Alfabética (A–Z)</option><option value="expiry">Validade (mais próxima)</option><option value="location">Local (A–Z)</option><option value="quantity-asc">Quantidade (menor primeiro)</option><option value="quantity-desc">Quantidade (maior primeiro)</option></select></label>
            </div>
            <div className="report-results-bar">
              <span>Alimentos</span>
              <div className="report-view-toggle" role="group" aria-label="Visualização do estoque">
                <button type="button" className={reportView==='list'?'active':''} aria-pressed={reportView==='list'} onClick={()=>setReportView('list')}><List size={16}/> Lista</button>
                <button type="button" className={reportView==='details'?'active':''} aria-pressed={reportView==='details'} onClick={()=>setReportView('details')}><LayoutGrid size={16}/> Detalhes</button>
              </div>
            </div>
            {reportFoods.length?(
              reportView==='list'?(
                <div className="report-list" aria-label="Alimentos em lista">
                  {reportFoods.map(food=><div className="report-list-row" key={food.id}>
                    <div className="report-list-copy">
                      <strong>{food.name}</strong>
                      <div className="report-list-meta"><button type="button" className="report-place-link" onClick={()=>{setSelected(food.placeId);setSelectedSub(food.subId)}}>{food.placeName}<ChevronRight size={13}/></button></div>
                      {food.expires_on?<small className={'report-list-expiry '+(daysUntilExpiry(food.expires_on)<0?'expired':daysUntilExpiry(food.expires_on)<=3?'urgent':'')}>{food.expires_on.split('-').reverse().join('/')} · {expiryCaption(food.expires_on)}</small>:<small className="report-list-expiry no-date">Validade não informada</small>}
                    </div>
                    <span className="report-list-quantity" aria-label={'Quantidade: '+formatQuantity(food.quantity,food.unit)}>{formatQuantity(food.quantity,food.unit)}</span>
                  </div>)}
                </div>
              ):(
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead><tr><th>Alimento</th><th>Onde está</th><th>Quantidade</th><th>Validade</th></tr></thead>
                    <tbody>{reportFoods.map(food=><tr key={food.id}>
                      <td data-label="Alimento"><strong>{food.name}</strong></td>
                      <td data-label="Onde está"><button className="report-place-link" onClick={()=>{setSelected(food.placeId);setSelectedSub(food.subId)}}>{food.placeName}<ChevronRight size={14}/></button></td>
                      <td data-label="Quantidade"><span className="report-quantity">{formatQuantity(food.quantity,food.unit)}</span>{food.quantity===0&&<small className="report-out">Sem estoque</small>}</td>
                      <td data-label="Validade">{food.expires_on?<span className="report-expiry"><strong>{food.expires_on.split('-').reverse().join('/')}</strong><small className={'expiry-label '+(daysUntilExpiry(food.expires_on)<0?'expired':daysUntilExpiry(food.expires_on)<=3?'urgent':'')}>{expiryCaption(food.expires_on)}</small></span>:<span className="report-no-expiry">Não informada</span>}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              )
            ):(
              <div className="report-empty"><ClipboardList size={28}/><strong>{total===0?'Seu estoque ainda está vazio':'Nenhum alimento encontrado'}</strong><span>{total===0?'Cadastre alimentos nos locais para que eles apareçam neste relatório.':'Tente mudar a busca ou selecionar outro local.'}</span>{(reportSearch||reportLocation!=='all')&&<button className="secondary-action" onClick={()=>{setReportSearch('');setReportLocation('all')}}>Limpar filtros</button>}</div>
            )}
          </section>
        ):(
          <section>
            <div className="home-tools">
              <div className="search">
                <Search size={19}/>
                <input aria-label="Buscar alimento" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Onde está o seu alimento?"/>
                {search&&<button onClick={()=>setSearch('')} aria-label="Limpar busca"><X size={17}/></button>}
              </div>
              {!search&&(
                <button type="button" className="home-add" onClick={()=>setAddActionModal(true)}>
                  <span className="home-add-icon"><Plus size={20}/></span>
                  <span>
                    <strong>Adicionar alimento</strong>
                  </span>
                  <ChevronRight size={18}/>
                </button>
              )}
            </div>

            {!search&&(
              <section className="home-overview" aria-label="Resumo da casa">
                <div className="home-overview-content">
                  <div className="home-overview-heading">
                    <div><h3>Resumo da casa{households.find(h=>h.id===householdId)?.name&&<> {households.find(h=>h.id===householdId)!.name}</>}</h3></div>
                  </div>
                  <div className="home-stat-grid">
                    <article className="home-stat">
                      <div><strong>{total}</strong><span>{total===1?'alimento cadastrado':'alimentos cadastrados'}</span></div>
                    </article>
                    <article className="home-stat">
                      <div><strong>{places.length}</strong><span>{places.length===1?'local organizado':'locais organizados'}</span></div>
                    </article>
                    <article className="home-stat">
                      <div><strong>{expiringFoods.filter(({food})=>food.quantity>0).length}</strong><span>itens perto da validade</span></div>
                    </article>
                  </div>
                  <div className="home-shortcuts" aria-label="Acessos rápidos">
                    <button type="button" onClick={()=>{setWorkspace('shopping');setSelected(null);setSelectedSub(null)}}>
                      <span className="home-shortcut-icon"><ShoppingCart size={17}/></span>
                      <span><strong>Lista de compras</strong><small>{shoppingItems.filter(item=>!item.is_purchased).length} {shoppingItems.filter(item=>!item.is_purchased).length===1?'item pendente':'itens pendentes'}</small></span>
                      <ChevronRight size={17}/>
                    </button>
                    <button type="button" onClick={()=>{setWorkspace('recipes');setSelected(null);setSelectedSub(null)}}>
                      <span className="home-shortcut-icon recipes"><BookOpen size={17}/></span>
                      <span><strong>Encontrar receitas</strong><small>Ideias com o que você tem em casa</small></span>
                      <ChevronRight size={17}/>
                    </button>
                  </div>
                </div>
              </section>
            )}

            {!search&&expiringFoods.length>0&&<section className="expiry-panel">
              <div className="smart-panel-heading"><div><p className="eyebrow">REDUZA O DESPERDÍCIO</p><h3>Validade próxima</h3><p>Itens vencidos ou que vencem nos próximos 7 dias.</p></div><span>{expiringFoods.length}</span></div>
              <div className="expiry-items">
                {expiringFoods.slice(0,5).map(({food,place,subdivision,days})=><div className="expiry-item" key={food.id}>
                  <div className="expiry-item-copy"><strong>{food.name}</strong><small>{formatQuantity(food.quantity,food.unit)} · {place.name}</small></div>
                  <span className={'expiry-label '+(days<0?'expired':days<=3?'urgent':'')}>{expiryCaption(food.expires_on!)}</span>
                  <button type="button" className="tertiary-action" onClick={()=>openSearchResult(place.id,subdivision.id)}>Ver</button>
                </div>)}
              </div>
            </section>}

            {search?(
              <>
                <div className="search-results-head">
                  <div>
                    <p className="eyebrow">RESULTADOS</p>
                    <h3>{results.length} {results.length===1?'alimento encontrado':'alimentos encontrados'}</h3>
                  </div>
                </div>

                {results.length?(
                  <div className="results">
                    {results.map(r=>(
                      <button className="result" key={r.id} onClick={()=>openSearchResult(r.placeId,r.subId)}>
                        <Apple size={18}/>
                        <span>
                          <strong>{r.name}</strong>
                          <small>{r.quantity===0?'Sem estoque':formatQuantity(r.quantity,r.unit)} · {r.place}</small>
                        </span>
                        <ChevronRight size={17}/>
                      </button>
                    ))}
                  </div>
                ):(
                  <div className="search-empty">
                    <Search size={24}/>
                    <h3>Nenhum alimento encontrado</h3>
                    <p>Tente outro nome ou limpe a busca para ver seus locais.</p>
                    <button className="primary" onClick={()=>setSearch('')}>Ver meus locais</button>
                  </div>
                )}
              </>
            ):(
              <>
                <div className="section-title">
                  <div>
                    <h3>Seus locais</h3>
                    <p className="section-caption">{total} {total===1?'alimento':'alimentos'} em {places.length} {places.length===1?'local':'locais'}</p>
                  </div>
                  <button onClick={()=>{setPlaceToEdit(null);setPlaceModal(true)}}><Plus size={17}/> Novo local</button>
                </div>

                {places.length===0?(
                  <div className="no-places">
                    <div className="no-places-icon"><Box size={22}/></div>
                    <h3>Comece pelo primeiro local</h3>
                    <p>Crie uma geladeira, despensa ou outro lugar para começar a organizar seus alimentos.</p>
                    <button className="primary" onClick={()=>{setPlaceToEdit(null);setPlaceModal(true)}}><Plus size={18}/> Criar primeiro local</button>
                  </div>
                ):(
                  <div className="places">
                    {places.map(p=>(
                      <div
                        className="place-card"
                        key={p.id}
                        role="button"
                        aria-label={'Abrir '+p.name}
                        tabIndex={0}
                        onClick={()=>openPlace(p.id)}
                        onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPlace(p.id)}}}
                      >
                        <div className={'place-photo '+locationPhotoClass(p.name)} aria-hidden="true">
                        </div>
                        <h3>{p.name}</h3>
                        <div className="place-card-summary">
                          <p>{p.subdivisions.reduce((n,s)=>n+s.foods.length,0)} {p.subdivisions.reduce((n,s)=>n+s.foods.length,0)===1?'alimento':'alimentos'}</p>
                        </div>
                        {p.subdivisions.some(s=>s.foods.some(food=>food.quantity===0))&&<div className="place-stock-note"><span/>{p.subdivisions.reduce((n,s)=>n+s.foods.filter(food=>food.quantity===0).length,0)} {p.subdivisions.reduce((n,s)=>n+s.foods.filter(food=>food.quantity===0).length,0)===1?'item sem estoque':'itens sem estoque'}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {recentFoods.length>0&&places.length>0&&(
                  <section className="home-recent" aria-label="Alimentos recentes">
                    <div className="section-title home-recent-heading">
                      <div><h3>Adicionados recentemente</h3><p className="section-caption">Continue de onde você parou</p></div>
                      <button onClick={()=>{setWorkspace('report');setSelected(null);setSelectedSub(null)}}>Ver estoque <ChevronRight size={16}/></button>
                    </div>
                    <div className="home-recent-grid">
                      {recentFoods.slice(0,4).map((recent,index)=>{
                        const match=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods.map(food=>({food,place,subdivision})))).find(item=>searchKey(item.food.name)===searchKey(recent.name));
                        return (
                          <button type="button" className="home-recent-item" key={searchKey(recent.name)} onClick={()=>{
                            if(match)openSearchResult(match.place.id,match.subdivision.id);
                            else{setSearch(recent.name);setWorkspace('inventory');setSelected(null);setSelectedSub(null);}
                          }}>
                            <span className={'home-recent-thumb thumb-'+(index%4)} aria-hidden="true">{recent.name.trim().split(/\s+/).slice(0,2).map(part=>part.charAt(0)).join('').toLocaleUpperCase('pt-BR')}</span>
                            <span className="home-recent-copy"><strong>{recent.name}</strong><small>{match?match.place.name:'Adicionado recentemente'}</small><small>{match?formatQuantity(match.food.quantity,match.food.unit):recent.unit}</small></span>
                            <ChevronRight size={17}/>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </>
            )}
          </section>
        )}

      </main>

      <nav className="bottom-nav" aria-label="Navegação principal">
        <button className={!selected&&workspace==='inventory'?'active':''} onClick={()=>{setWorkspace('inventory');setSelected(null);setSelectedSub(null)}} aria-current={!selected&&workspace==='inventory'?'page':undefined}><Home size={20}/><span>Início</span></button>
        <button className={!selected&&workspace==='shopping'?'active':''} onClick={()=>{setWorkspace('shopping');setSelected(null);setSelectedSub(null)}} aria-current={!selected&&workspace==='shopping'?'page':undefined}><ShoppingCart size={20}/><span>Compras</span>{shoppingItems.filter(item=>!item.is_purchased).length>0&&<i>{shoppingItems.filter(item=>!item.is_purchased).length>99?'99+':shoppingItems.filter(item=>!item.is_purchased).length}</i>}</button>
        <button className={!selected&&workspace==='recipes'?'active':''} onClick={()=>{setWorkspace('recipes');setSelected(null);setSelectedSub(null)}} aria-current={!selected&&workspace==='recipes'?'page':undefined}><BookOpen size={20}/><span>Receitas</span></button>
        <button className={!selected&&workspace==='report'?'active':''} onClick={()=>{setWorkspace('report');setSelected(null);setSelectedSub(null)}} aria-current={!selected&&workspace==='report'?'page':undefined}><ClipboardList size={20}/><span className="nav-label-full">Lista geral</span><span className="nav-label-compact">Estoque</span></button>
        <button className={!selected&&workspace==='settings'?'active':''} onClick={()=>{setWorkspace('settings');setSelected(null);setSelectedSub(null)}} aria-current={!selected&&workspace==='settings'?'page':undefined}><Settings size={20}/><span>Ajustes</span></button>
      </nav>

      {addActionModal&&<Modal title="Adicionar à sua casa" onClose={()=>setAddActionModal(false)}>
        <p className="modal-help">Como você gostaria de adicionar seus alimentos?</p>
        <div className="add-action-choices">
          <button type="button" className="add-action-choice" onClick={()=>{setAddActionModal(false);openAddFoodFromHome()}}>
            <span className="add-action-choice-icon individual"><Plus size={19}/></span>
            <span><strong>Adicionar um alimento</strong><small>Cadastre nome, quantidade, unidade e local.</small></span>
            <ChevronRight size={17}/>
          </button>
          <button type="button" className="add-action-choice" onClick={()=>{setAddActionModal(false);if(!userId){promptAccount('importar alimentos para o estoque');return;}setImportModal(true)}}>
            <span className="add-action-choice-icon import"><ClipboardList size={19}/></span>
            <span><strong>Importar lista</strong><small>Adicione vários alimentos de uma só vez.</small></span>
            <ChevronRight size={17}/>
          </button>
        </div>
      </Modal>}
      {importModal&&<ImportInventoryModal places={places} onClose={()=>setImportModal(false)} onImport={async(placeId,rows)=>{
        const place=places.find(item=>item.id===placeId);
        const destination=place?.subdivisions[0];
        if(!place||!destination||!rows.length)return;
        const imported=rows.map(row=>({id:uid(),name:row.name.trim(),quantity:Math.max(0,row.quantity),unit:row.unit,expires_on:row.expires_on||null}));
        setPlaces(prev=>prev.map(item=>item.id!==placeId?item:{...item,subdivisions:item.subdivisions.map(sub=>sub.id!==destination.id?sub:{...sub,foods:[...sub.foods,...imported]})}));
        for(const food of imported){
          if(userId)await writeOrQueue(userId,{userId,table:'foods',action:'upsert',rowId:food.id,data:{id:food.id,user_id:userId,subdivision_id:destination.id,name:food.name,quantity:food.quantity,unit:food.unit,expires_on:food.expires_on}});
          rememberFood(food.name,food.unit);
        }
        setImportModal(false);
        setAuthMessage(imported.length+' '+(imported.length===1?'produto importado':'produtos importados')+' para '+place.name+'.');
      }}/>} 
      {foodModal&&(
        <FoodModal
          data={foodModal.food}
          placeId={foodModal.place}
          subId={foodModal.sub}
          places={places}
          recentFoods={recentFoods}
          onClose={()=>setFoodModal(null)}
          onSave={(placeId,subId,d,daysPerUnit)=>{if(foodModal.food&&d.quantity===0){setZeroQtyConfirm({placeId,subId,food:foodModal.food});setFoodModal(null);return;}void (async()=>{const newFoodId=await saveFood(placeId,subId,d,foodModal.food?.id);if(newFoodId&&daysPerUnit)saveConsumptionRule(newFoodId,daysPerUnit);})();}}
          onAddToExisting={(placeId,subId,existingId,amount,unit)=>addToExistingFood(placeId,subId,existingId,amount,unit)}
        />
      )}
      {zeroQtyConfirm&&<div className="overlay" role="presentation"><section className="modal zero-stock-modal" role="alertdialog" aria-modal="true" aria-labelledby="zero-stock-title" aria-describedby="zero-stock-description"><div className="modal-head"><h2 id="zero-stock-title">O que deseja fazer?</h2><button type="button" onClick={()=>setZeroQtyConfirm(null)} aria-label="Fechar"><X size={18}/></button></div><p id="zero-stock-description" className="modal-help">A quantidade de <strong>{zeroQtyConfirm.food.name}</strong> chegou a zero. Você pode removê-lo do estoque ou já adicioná-lo à lista de compras.</p><div className="zero-stock-actions"><button type="button" className="secondary-action" onClick={()=>setZeroQtyConfirm(null)}>Cancelar</button><button type="button" className="secondary-action" onClick={()=>{const target=zeroQtyConfirm;setZeroQtyConfirm(null);void removeFood(target.placeId,target.subId,target.food.id);}}>Excluir</button><button type="button" className="primary" onClick={()=>{const target=zeroQtyConfirm;if(!userId||!householdId){setZeroQtyConfirm(null);setAuthMessage('Entre na sua conta para adicionar alimentos à lista de compras compartilhada.');setAuthModal(true);return;}setZeroQtyConfirm(null);void (async()=>{await addShoppingItem(target.food.name,quantityStep(target.food.unit),target.food.unit,'low_stock');await removeFood(target.placeId,target.subId,target.food.id);})();}}>Excluir e adicionar à lista de compras</button></div></section></div>}
      {moveModal&&<MoveModal data={moveModal} places={places} onClose={()=>setMoveModal(null)} onMove={moveFood}/>} 
      {placeModal&&<PlaceModal places={places} initialEditId={placeToEdit} onClose={()=>{setPlaceModal(false);setPlaceToEdit(null)}} onSave={savePlace} onDelete={async id=>{const ok=await removePlace(id);if(ok){setPlaceModal(false);setPlaceToEdit(null)}return ok}}/>}
      {subModal&&<SubModal data={subModal.sub} onClose={()=>setSubModal(null)} onSave={n=>saveSub(subModal.place,n,subModal.sub?.id)} onDelete={id=>removeSub(subModal.place,id)}/>}
      {authModal&&<AuthModal initialMode={authMessage?.startsWith('Crie uma conta')?'signup':'signin'} busy={authBusy} onClose={()=>setAuthModal(false)} onSubmit={handleEmailAuth} onReset={resetPassword}/>}
      {cookConfirmRecipe&&<RecipeCookModal recipe={cookConfirmRecipe} onClose={()=>setCookConfirmRecipe(null)} onConfirm={()=>void cookRecipe(cookConfirmRecipe)}/>}
      {consumptionRuleModal&&<ConsumptionRuleModal
        food={places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods)).find(food=>food.id===consumptionRuleModal.foodId)}
        rule={consumptionRules.find(rule=>rule.food_id===consumptionRuleModal.foodId)}
        onClose={()=>setConsumptionRuleModal(null)}
        onSave={saveConsumptionRule}
        onDelete={()=>removeConsumptionRule(consumptionRuleModal.foodId)}
      />}
      {shoppingStockItem&&<ShoppingStockModal
        item={shoppingStockItem}
        places={places}
        onClose={()=>setShoppingStockItem(null)}
        onConfirm={addPurchasedShoppingToStock}
      />}
      {shoppingAddFood&&<AddFoodToShoppingModal food={shoppingAddFood} onClose={()=>setShoppingAddFood(null)} onConfirm={quantity=>{void addShoppingItem(shoppingAddFood.name,quantity,shoppingAddFood.unit,'manual');setShoppingAddFood(null)}}/>}
      {householdModal&&<HouseholdModal
        busy={householdBusy}
        households={households}
        activeHouseholdId={householdId}
        invite={householdInvite}
        joinCode={householdJoinCode}
        copied={householdCopied}
        onClose={()=>setHouseholdModal(false)}
        onSwitch={id=>void activateHousehold(id,userId,true)}
        onRename={renameHousehold}
        onCreateInvite={createHouseholdInvite}
        onLeave={leaveHousehold}
        onCreateHousehold={createHousehold}
        currentUserId={userId}
        onJoin={joinHousehold}
        onJoinCodeChange={setHouseholdJoinCode}
        onCopy={async code=>{try{await navigator.clipboard.writeText(code);setHouseholdCopied(true)}catch{setAuthMessage('Não foi possível copiar automaticamente. Selecione o código para copiá-lo.')}}}
      />}
      {signOutConfirm&&<Modal title="Sair da conta?" onClose={()=>setSignOutConfirm(false)}><p className="modal-help">Tem certeza de que deseja sair do ShelfSpace neste dispositivo? Seus dados sincronizados continuarão salvos.</p><div className="household-rename-actions"><button type="button" disabled={authBusy} onClick={()=>setSignOutConfirm(false)}>Cancelar</button><button type="button" className="primary" disabled={authBusy} onClick={()=>{setSignOutConfirm(false);void signOut();}}>{authBusy?'Saindo…':'Sim, sair da conta'}</button></div></Modal>}
      {passwordRecovery&&<PasswordRecoveryModal busy={authBusy} onClose={()=>setPasswordRecovery(false)} onSubmit={updatePassword}/>}
      {passwordChangeModal&&<AccountPasswordModal busy={authBusy} onClose={()=>setPasswordChangeModal(false)} onSubmit={changeAccountPassword}/>}
       {deleteAccountConfirm&&<AccountDeletionModal busy={authBusy} onClose={()=>setDeleteAccountConfirm(false)} onSubmit={deleteAccount}/>}
      {undo&&<div className="undo-toast" role="status" aria-live="polite"><span>{undo.label}</span><button onClick={consumeUndo}>Desfazer</button></div>}
      {actionFeedback&&<div className="action-feedback" role="status" aria-live="polite">✓ {actionFeedback}</div>}
    </div>
  );
}

function AccountDeletionModal({busy,onClose,onSubmit}:{busy:boolean;onClose:()=>void;onSubmit:(password:string)=>Promise<string|null>}){
  const[password,setPassword]=useState('');
  const[error,setError]=useState('');
  const submit=async()=>{
    if(!password||busy)return;
    setError('');
    const result=await onSubmit(password);
    if(result)setError(result);
  };
  return <Modal title="Excluir minha conta?" onClose={busy?()=>{}:onClose}>
    <p className="modal-help">Esta ação é permanente. Sua conta e seus dados pessoais de autenticação serão excluídos. Os dados de uma casa compartilhada serão preservados para os outros membros; se você for a última pessoa da casa, os dados dessa casa também serão excluídos.</p>
    <label>Confirme sua senha<input type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password" required/></label>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="household-rename-actions">
      <button type="button" disabled={busy} onClick={onClose}>Cancelar</button>
      <button type="button" className="danger-button" disabled={busy||!password} onClick={()=>void submit()}>{busy?'Excluindo…':'Excluir conta permanentemente'}</button>
    </div>
  </Modal>
}

function AccountPasswordModal({busy,onClose,onSubmit}:{busy:boolean;onClose:()=>void;onSubmit:(password:string)=>Promise<string|null>}){
  const[password,setPassword]=useState('');
  const[confirm,setConfirm]=useState('');
  const[error,setError]=useState<string|null>(null);
  const[showPassword,setShowPassword]=useState(false);
  const canSave=password.length>=8&&password===confirm&&!busy;
  const submit=async()=>{
    if(!canSave)return;
    setError(null);
    const result=await onSubmit(password);
    if(result)setError(result);
  };
  return <Modal title="Alterar senha" onClose={onClose}>
    <p className="modal-help">Crie uma nova senha com pelo menos 8 caracteres. Sua sessão atual será mantida.</p>
    <label>Nova senha<input autoFocus type={showPassword?'text':'password'} value={password} onChange={e=>{setPassword(e.target.value);setError(null)}} placeholder="Mínimo de 8 caracteres" autoComplete="new-password"/></label>
    <label>Confirmar nova senha<input type={showPassword?'text':'password'} value={confirm} onChange={e=>{setConfirm(e.target.value);setError(null)}} placeholder="Digite a nova senha novamente" autoComplete="new-password"/></label>
    <label className="password-show-option"><input type="checkbox" checked={showPassword} onChange={e=>setShowPassword(e.target.checked)}/> Mostrar senhas</label>
    {confirm&&password!==confirm&&<p className="password-mismatch" role="status">As senhas não coincidem.</p>}
    {error&&<p className="password-form-error" role="alert">{error}</p>}
    <button className="primary full" disabled={!canSave} onClick={()=>void submit()}>{busy?'Salvando…':'Salvar nova senha'}</button>
  </Modal>
}

function PasswordRecoveryModal({busy,onClose,onSubmit}:{busy:boolean;onClose:()=>void;onSubmit:(password:string)=>void}){
  const[password,setPassword]=useState('');
  const[confirm,setConfirm]=useState('');
  const canSave=password.length>=6&&password===confirm;
  return <Modal title="Criar nova senha" onClose={onClose}>
    <p className="modal-help">Escolha uma nova senha para continuar usando sua conta.</p>
    <label>Nova senha<input type="password" autoFocus value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mínimo de 6 caracteres" autoComplete="new-password"/></label>
    <label>Confirmar senha<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Digite a senha novamente" autoComplete="new-password"/></label>
    {confirm&&password!==confirm&&<p className="password-mismatch">As senhas não coincidem.</p>}
    <button className="primary full" disabled={busy||!canSave} onClick={()=>onSubmit(password)}>{busy?'Aguarde...':'Salvar nova senha'}</button>
  </Modal>
}

function AuthModal({busy,onClose,onSubmit,onReset,initialMode='signin'}:{busy:boolean;onClose:()=>void;onSubmit:(mode:'signin'|'signup',email:string,password:string)=>void;onReset:(email:string)=>void;initialMode?:'signin'|'signup'}){
  const[mode,setMode]=useState<'signin'|'signup'>(initialMode);
  const[email,setEmail]=useState('');
  const[password,setPassword]=useState('');
  return <Modal title={mode==='signin'?'Entrar no ShelfSpace':'Criar sua conta'} onClose={onClose}>
    <p className="modal-help">{mode==='signin'?'Entre para acessar seus alimentos em qualquer dispositivo.':'Crie uma conta para manter seu histórico sincronizado no celular, PC e outros navegadores.'}</p>
    <label>E-mail<input type="email" autoFocus value={email} onChange={e=>setEmail(e.target.value)} placeholder="voce@email.com" autoComplete="email"/></label>
    <label>Senha<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mínimo de 6 caracteres" autoComplete={mode==='signin'?'current-password':'new-password'}/></label>
    <button className="primary full" disabled={busy||!email.trim()||password.length<6} onClick={()=>onSubmit(mode,email.trim(),password)}>{busy?'Aguarde...':mode==='signin'?'Entrar':'Criar conta'}</button>
    {mode==='signin'&&<button className="auth-link" disabled={busy||!email.trim()} onClick={()=>onReset(email.trim())}>Esqueci minha senha</button>}
    <button className="auth-switch" onClick={()=>setMode(mode==='signin'?'signup':'signin')}>{mode==='signin'?'Ainda não tenho uma conta':'Já tenho uma conta'}</button>
  </Modal>
}

function RecipePage({places,onAddMissing,onCook}:{places:Place[];onAddMissing:(items:Pick<RecipeIngredient,'name'|'quantity'|'unit'|'measureText'>[])=>void;onCook:(recipe:Recipe)=>void}){
  const[query,setQuery]=useState('');
  const[filter,setFilter]=useState<'all'|'ready'|'needs'>('all');
  const[expanded,setExpanded]=useState<string|null>(null);
  const[onlineRecipes,setOnlineRecipes]=useState<Recipe[]>([]);
  const[onlineLoading,setOnlineLoading]=useState(false);
  const[onlineError,setOnlineError]=useState('');
  const[onlineLoaded,setOnlineLoaded]=useState(false);
  const pantry:RecipePantryItem[]=places.flatMap(place=>place.subdivisions.flatMap(subdivision=>subdivision.foods));
  async function loadOnlineRecipes(){
    if(!pantry.length){setOnlineError('Adicione alguns alimentos ao estoque para buscar receitas compatíveis.');return;}
    setOnlineLoading(true);setOnlineError('');
    try{
      const{data,error}=await supabase.functions.invoke('recipe-suggestions',{body:{ingredients:pantry.map(item=>item.name).filter(Boolean)}});
      if(error)throw error;
      const found=Array.isArray(data?.recipes)?data.recipes as Recipe[]:[];
      setOnlineRecipes(found);
      setOnlineLoaded(true);
      if(!found.length)setOnlineError('Não encontramos receitas online para os ingredientes cadastrados. Tente adicionar ingredientes mais comuns.');
    }catch{
      setOnlineError('Não foi possível consultar as receitas online agora. Tente novamente em instantes.');
    }finally{setOnlineLoading(false);}
  }
  const allRecipes=[...recipes,...onlineRecipes];
  const options=allRecipes.map(recipe=>{
    const statuses=getRecipeIngredientStatuses(recipe,pantry);
    const ready=statuses.every(status=>status.enough===true);
    const available=statuses.filter(status=>status.enough===true||status.enough===null).length;
    const unknown=statuses.filter(status=>status.enough===null).length;
    const missing=statuses.filter(status=>status.enough===false);
    const expiring=statuses.filter(status=>status.matches.some(item=>!!item.expires_on&&daysUntilExpiry(item.expires_on)<=3)).length;
    return{recipe,statuses,ready,available,unknown,missing,expiring};
  });
  const q=searchKey(query.trim());
  const filtered=options.filter(option=>{
    const recipe=option.recipe;
    const matchesQuery=!q||searchKey(recipe.name+' '+recipe.description+' '+recipe.ingredients.map(i=>i.name+' '+i.aliases.join(' ')).join(' ')).includes(q);
    const matchesFilter=filter==='all'||(filter==='ready'?option.ready:!option.ready);
    return matchesQuery&&matchesFilter;
  }).sort((a,b)=>Number(b.ready)-Number(a.ready)||b.expiring-a.expiring||b.available-a.available||a.recipe.minutes-b.recipe.minutes);
  return <section className="recipe-page">
    <div className="hero recipe-hero">
      <div className="hero-copy">
        <p className="eyebrow">COZINHE COM O QUE JÁ TEM</p>
        <h2>Ideias para cozinhar</h2>
        <p>Receitas com o que você já tem e ingredientes próximos da validade. O que faltar pode ir para a lista de compras.</p>
      </div>
    </div>
    <div className="recipe-online-controls">
      <button className="secondary-action" onClick={()=>void loadOnlineRecipes()} disabled={onlineLoading}><BookOpen size={16}/>{onlineLoading?'Buscando receitas...':onlineLoaded?'Atualizar sugestões':'Buscar receitas online'}</button>
      <span>Encontre novas ideias a partir dos ingredientes cadastrados no seu estoque. Algumas receitas podem estar em outro idioma.</span>
    </div>
    {onlineError&&<p className="recipe-online-message" role="status">{onlineError}</p>}
    <div className="recipe-search search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar receita ou ingrediente" aria-label="Buscar receita ou ingrediente"/>{query&&<button onClick={()=>setQuery('')} aria-label="Limpar busca"><X size={16}/></button>}</div>
    <div className="recipe-filters" aria-label="Filtrar receitas">
      <button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Todas ({options.length})</button>
      <button className={filter==='ready'?'active':''} onClick={()=>setFilter('ready')}>Tenho tudo ({options.filter(option=>option.ready).length})</button>
      <button className={filter==='needs'?'active':''} onClick={()=>setFilter('needs')}>Faltam itens ({options.filter(option=>!option.ready).length})</button>
    </div>
    {filtered.length===0?<div className="shopping-empty"><BookOpen size={25}/><strong>Nenhuma receita encontrada</strong><span>Tente outra busca ou selecione outro filtro.</span></div>:<div className="recipe-grid">
      {filtered.map(({recipe,statuses,ready,available,unknown,missing,expiring})=>{
        const isExpanded=expanded===recipe.id;
        const missingItems=missing.map(status=>({name:status.ingredient.name,quantity:Number(status.missingQuantity.toFixed(3)),unit:status.ingredient.unit,...(status.ingredient.measureText?{measureText:status.ingredient.measureText}:{})}));
        return <article className="recipe-card" key={recipe.id}>
          <div className="recipe-card-top"><div><p className="eyebrow">{recipe.source==='afrodite'?'BASE AFRODITE':recipe.source==='themealdb'?'THEMEALDB':ready?'PRONTO PARA PREPARAR':expiring?'USE O QUE VENCE PRIMEIRO':'IDEIA PARA HOJE'}</p><h3>{recipe.name}</h3></div><span className={'recipe-status '+(ready?'ready':'')}>{ready?'Você tem tudo':available+'/'+recipe.ingredients.length+' itens'}</span></div>
          <p className="recipe-description">{recipe.description}</p>
          {recipe.sourceUrl&&<p className="recipe-source"><a href={recipe.sourceUrl} target="_blank" rel="noreferrer">{recipe.source==='afrodite'?'Conhecer a base Afrodite':'Ver receita original no TheMealDB'} <MoveRight size={13}/></a></p>}
          <div className="recipe-meta"><span>{recipe.minutes>0?recipe.minutes+' min':'Tempo não informado'}</span><span>{recipe.servings>0?recipe.servings+' '+(recipe.servings===1?'porção':'porções'):'Porções não informadas'}</span><span>{available} de {recipe.ingredients.length} ingredientes encontrados</span></div>
          <div className="recipe-progress"><span style={{width:Math.round(available/recipe.ingredients.length*100)+'%'}}/></div>
          {unknown>0&&<p className="recipe-hint">{unknown} ingrediente(s) existe(m), mas usa(m) outra unidade. Confira a quantidade antes de cozinhar.</p>}
          <button className="recipe-detail-toggle" onClick={()=>setExpanded(isExpanded?null:recipe.id)}>{isExpanded?'Ocultar receita':'Ver ingredientes e preparo'} <ChevronRight size={16}/></button>
          {isExpanded&&<div className="recipe-detail">
            <div className="recipe-ingredients"><strong>Ingredientes</strong>
              {statuses.map(status=><div className="recipe-ingredient" key={status.ingredient.name}>
                <span className={'recipe-ingredient-icon '+(status.enough===true?'available':status.enough===false?'missing':'unknown')}>{status.enough===true?'✓':status.enough===false?'!':'?'}</span>
                <div><strong>{status.ingredient.name}</strong><small>{recipe.presenceOnly?(status.ingredient.measureText||'Quantidade não informada')+(status.enough===true?' · presente no estoque; confira a quantidade':status.enough===false?' · não encontrado no estoque':'') : formatQuantity(status.ingredient.quantity,status.ingredient.unit)+(status.enough===true?' · disponível':status.enough===false?' · falta '+formatQuantity(status.missingQuantity,status.ingredient.unit):' · confira a unidade')}{status.expiredMatches.length>0?(status.matches.length?' · também há item vencido':' · só há item vencido'):''}</small></div>
              </div>)}
            </div>
            <div className="recipe-steps"><strong>Modo de preparo</strong><ol>{recipe.instructions.map((step,index)=><li key={index}>{step}</li>)}</ol></div>
            <div className="recipe-actions">
              {missingItems.length>0&&<button className="secondary-action" onClick={()=>onAddMissing(missingItems)}><ShoppingCart size={15}/> Adicionar faltantes à lista</button>}
              {!recipe.presenceOnly&&<button className="primary" disabled={!ready} onClick={()=>onCook(recipe)}>Marcar como preparada</button>}
              {recipe.presenceOnly&&<small>Receita externa: confira as medidas na fonte. O estoque não será descontado automaticamente.</small>}
              {!ready&&!recipe.presenceOnly&&<small>Para descontar o estoque, todos os ingredientes precisam estar disponíveis em quantidade e unidade comparáveis.</small>}
            </div>
          </div>}
        </article>;
      })}
    </div>}
    <p className="recipe-disclaimer">As sugestões online vêm do TheMealDB e podem estar no idioma original. Para receitas externas, confira as medidas e o preparo na fonte antes de cozinhar.</p>
  </section>
}

function RecipeCookModal({recipe,onClose,onConfirm}:{recipe:Recipe;onClose:()=>void;onConfirm:()=>void}){
  return <Modal title="Marcar receita como preparada" onClose={onClose}>
    <div className="move-current"><span>Receita</span><strong>{recipe.name}</strong><small>{recipe.servings} {recipe.servings===1?'porção':'porções'} · {recipe.minutes} min</small></div>
    <p className="modal-help">O ShelfSpace vai descontar as quantidades previstas do estoque, priorizando os alimentos com validade mais próxima. Nada será descontado se faltar ingrediente ou não for possível comparar as unidades.</p>
    <div className="recipe-cook-list">{recipe.ingredients.map(ingredient=><div key={ingredient.name}><span>{ingredient.name}</span><strong>{formatQuantity(ingredient.quantity,ingredient.unit)}</strong></div>)}</div>
    <button className="primary full" onClick={onConfirm}>Confirmar preparo e atualizar estoque</button>
  </Modal>
}

function ConsumptionRuleModal({food,rule,onClose,onSave,onDelete}:{food?:Food;rule?:ConsumptionRule;onClose:()=>void;onSave:(foodId:string,daysPerUnit:number)=>void;onDelete:()=>void}){
  const initialDays=rule?Math.max(1,Math.round(rule.period_days/Math.max(1,rule.amount))):7;
  const[daysPerUnit,setDaysPerUnit]=useState(initialDays);
  if(!food)return <Modal title="Programar consumo" onClose={onClose}><p className="modal-help">Este alimento não está mais no estoque.</p></Modal>;
  const totalDays=Number.isInteger(daysPerUnit)&&daysPerUnit>0?Math.round(food.quantity*daysPerUnit):0;
  return <Modal title={rule?'Editar consumo previsto':'Programar consumo'} onClose={onClose}>
    <div className="move-current"><span>Alimento</span><strong>{food.name}</strong><small>Estoque atual: {formatQuantity(food.quantity,food.unit)}</small></div>
    <p className="modal-help">Informe por quantos dias uma unidade costuma durar. Na data prevista, perguntaremos se você consumiu uma unidade. O estoque só muda quando confirmar.</p>
    <label>Quantos dias dura uma unidade?<input type="number" min="1" max="365" step="1" value={daysPerUnit} onChange={e=>setDaysPerUnit(Number(e.target.value))}/></label>
    <div className="consumption-rule-help">Com {formatQuantity(food.quantity,food.unit)} em estoque, a duração estimada é de {totalDays} dias. Exemplo: 3 caixas, 7 dias por caixa = 21 dias.</div>
    <button className="primary full" disabled={!Number.isInteger(daysPerUnit)||daysPerUnit<1||daysPerUnit>365} onClick={()=>onSave(food.id,daysPerUnit)}>{rule?'Salvar programação':'Ativar consumo previsto'}</button>
    {rule&&<button className="text-danger" onClick={onDelete}><Trash2 size={15}/> Remover programação</button>}
  </Modal>
}
function ShoppingPage({places,items,loading,signedIn,recurringRules,recurringBusy,onAdd,onToggle,onDelete,onEdit,onStock,onSignIn,onSaveRecurring,onToggleRecurring,onDeleteRecurring}:{places:Place[];items:ShoppingItem[];loading:boolean;signedIn:boolean;recurringRules:RecurringShoppingRule[];recurringBusy:boolean;onAdd:(name:string,quantity:number,unit:Unit)=>void;onToggle:(item:ShoppingItem)=>void;onDelete:(item:ShoppingItem)=>void;onEdit:(item:ShoppingItem,quantity:number,unit:Unit)=>void;onStock:(item:ShoppingItem)=>void;onSignIn:()=>void;onSaveRecurring:(input:{name:string;quantity:number;unit:Unit;frequencyDays:number;nextDueOn:string;id?:string})=>void;onToggleRecurring:(rule:RecurringShoppingRule)=>void;onDeleteRecurring:(rule:RecurringShoppingRule)=>void}){
  const[name,setName]=useState('');
  const[quantity,setQuantity]=useState(1);
  const[unit,setUnit]=useState<Unit>('unidades');
  const[recurringName,setRecurringName]=useState('');
  const[recurringQuantity,setRecurringQuantity]=useState(1);
  const[recurringUnit,setRecurringUnit]=useState<Unit>('unidades');
  const[recurringFrequency,setRecurringFrequency]=useState(7);
  const[recurringNextDue,setRecurringNextDue]=useState(localDateString());
  const[editingRecurringId,setEditingRecurringId]=useState<string|undefined>();
  const[editingShoppingItem,setEditingShoppingItem]=useState<ShoppingItem|null>(null);
  const[isAddFormOpen,setIsAddFormOpen]=useState(true);
  const pending=items.filter(item=>!item.is_purchased);
  const purchased=items.filter(item=>item.is_purchased);
  const submit=(event:{preventDefault:()=>void})=>{
    event.preventDefault();
    if(!signedIn){onSignIn();return}
    if(!name.trim()||!Number.isFinite(quantity)||quantity<=0)return;
    onAdd(name,quantity,unit);
    setName('');
    setQuantity(1);
    setUnit('unidades');
  };
  const resetRecurringForm=()=>{
    setRecurringName('');
    setRecurringQuantity(1);
    setRecurringUnit('unidades');
    setRecurringFrequency(7);
    setRecurringNextDue(localDateString());
    setEditingRecurringId(undefined);
  };
  const submitRecurring=(event:{preventDefault:()=>void})=>{
    event.preventDefault();
    if(!signedIn){onSignIn();return}
    if(!recurringName.trim()||!Number.isFinite(recurringQuantity)||recurringQuantity<=0||!Number.isInteger(recurringFrequency)||recurringFrequency<1||recurringFrequency>365)return;
    onSaveRecurring({name:recurringName,quantity:recurringQuantity,unit:recurringUnit,frequencyDays:recurringFrequency,nextDueOn:recurringNextDue||localDateString(),id:editingRecurringId});
    resetRecurringForm();
  };
  const editRecurring=(rule:RecurringShoppingRule)=>{
    setRecurringName(rule.name);
    setRecurringQuantity(rule.quantity);
    setRecurringUnit(units.includes(rule.unit as Unit)?rule.unit as Unit:'unidades');
    setRecurringFrequency(rule.frequency_days);
    setRecurringNextDue(rule.next_due_on);
    setEditingRecurringId(rule.id);
    document.getElementById('recurring-shopping-form')?.scrollIntoView({behavior:'smooth',block:'center'});
  };
  return <section className="shopping-page">
    <div className="hero shopping-hero">
      <div className="hero-copy">
        <p className="eyebrow">SUA CASA</p>
        <h2>Lista de compras</h2>
        <p>Uma lista compartilhada com sua casa, ligada ao estoque para facilitar a reposição.</p>
      </div>
    </div>
    {!signedIn?(
      <div className="no-places shopping-signin">
        <div className="no-places-icon"><Users size={22}/></div>
        <h3>Compartilhe suas compras</h3>
        <p>Entre na sua conta para manter a lista sincronizada entre os membros da casa.</p>
        <button className="primary" onClick={onSignIn}>Entrar ou criar conta</button>
      </div>
    ):<>
      <form className={'shopping-add-form '+(!isAddFormOpen?'is-collapsed':'')} onSubmit={submit}>
        <div className="shopping-form-heading">
          <button type="button" className="shopping-form-toggle" aria-expanded={isAddFormOpen} aria-controls="shopping-add-fields" onClick={()=>setIsAddFormOpen(open=>!open)}>
            <strong>Adicionar à lista</strong><ChevronDown size={19} aria-hidden="true"/>
          </button>
          {isAddFormOpen&&<span>Itens repetidos com a mesma unidade são somados.</span>}
        </div>
        <div id="shopping-add-fields" className="shopping-add-fields" hidden={!isAddFormOpen}>
          <label>Produto<input list="shopping-pantry-suggestions" value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Leite integral" maxLength={120}/><datalist id="shopping-pantry-suggestions">{Array.from(new Map(places.flatMap(place=>place.subdivisions.flatMap(sub=>sub.foods)).map(food=>[searchKey(food.name),food])).values()).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')).map(food=><option key={food.id} value={food.name}/>)}</datalist></label>
          <div className="shopping-form-row">
            <label>Quantidade<input type="number" min="0.01" step={unit==='kg'||unit==='L'?0.1:1} value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/></label>
            <label>Unidade<select value={unit} onChange={e=>setUnit(e.target.value as Unit)}>{units.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
            <button className="primary shopping-add-button" type="submit" disabled={!name.trim()||!Number.isFinite(quantity)||quantity<=0||loading}><Plus size={17}/> Adicionar</button>
          </div>
        </div>
      </form>
      <details className="recurring-panel">
        <summary><span className="recurring-summary-icon" aria-hidden="true"><ClipboardList size={20}/></span><span className="recurring-summary-copy"><strong>Reposições recorrentes</strong><small>Repor itens em intervalos definidos</small></span><b>{recurringRules.filter(rule=>rule.is_active).length}</b><ChevronRight className="recurring-summary-chevron" size={18} aria-hidden="true"/></summary>
        <form id="recurring-shopping-form" className="recurring-form" onSubmit={submitRecurring}>
          <strong>{editingRecurringId?'Editar reposição':'Criar uma reposição programada'}</strong>
          <label>Produto<input value={recurringName} onChange={e=>setRecurringName(e.target.value)} placeholder="Ex.: Leite integral" maxLength={120}/></label>
          <div className="recurring-form-row">
            <label>Quantidade<input type="number" min="0.01" step={recurringUnit==='kg'||recurringUnit==='L'?0.1:1} value={recurringQuantity} onChange={e=>setRecurringQuantity(Number(e.target.value))}/></label>
            <label>Unidade<select value={recurringUnit} onChange={e=>setRecurringUnit(e.target.value as Unit)}>{units.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
          </div>
          <div className="recurring-form-row">
            <label>Repetir a cada (dias)<input type="number" min="1" max="365" step="1" value={recurringFrequency} onChange={e=>setRecurringFrequency(Number(e.target.value))}/></label>
            <label>Próxima sugestão<input type="date" value={recurringNextDue} onChange={e=>setRecurringNextDue(e.target.value)}/></label>
          </div>
          <div className="recurring-form-actions">
            <button className="primary" type="submit" disabled={recurringBusy||!recurringName.trim()||!Number.isFinite(recurringQuantity)||recurringQuantity<=0||!Number.isInteger(recurringFrequency)||recurringFrequency<1||recurringFrequency>365}>{recurringBusy?'Salvando…':editingRecurringId?'Salvar alteração':'Programar reposição'}</button>
            {editingRecurringId&&<button className="secondary-action" type="button" onClick={resetRecurringForm}>Cancelar</button>}
          </div>
          <small className="recurring-note">Quando a data chegar, o item entra uma vez na lista compartilhada e a próxima data é calculada automaticamente.</small>
        </form>
        {recurringRules.length>0?<div className="recurring-rules">
          {recurringRules.map(rule=><div className={'recurring-rule '+(!rule.is_active?'inactive':'')} key={rule.id}>
            <div className="recurring-rule-copy"><strong>{rule.name}</strong><small>{formatQuantity(rule.quantity,units.includes(rule.unit as Unit)?rule.unit as Unit:'unidades')} · a cada {rule.frequency_days} {rule.frequency_days===1?'dia':'dias'}</small><small>{rule.is_active?'Próxima sugestão: '+rule.next_due_on:'Pausada'}</small></div>
            <div className="recurring-rule-actions"><button type="button" onClick={()=>editRecurring(rule)}>Editar</button><button type="button" onClick={()=>onToggleRecurring(rule)}>{rule.is_active?'Pausar':'Ativar'}</button><button type="button" onClick={()=>onDeleteRecurring(rule)} aria-label={'Excluir regra de '+rule.name}><Trash2 size={15}/></button></div>
          </div>)}
        </div>:<p className="recurring-empty">Nenhuma reposição programada. Crie uma rotina, como leite toda semana ou café todo mês.</p>}
      </details>
      <div className="shopping-section-heading">
        <div><h3>Para comprar</h3><p>{pending.length?pending.length+(pending.length===1?' item aguardando':' itens aguardando'):'Tudo comprado por enquanto'}</p></div>
        {loading&&<span className="shopping-loading">Sincronizando…</span>}
      </div>
      {pending.length? <div className="shopping-items">
        {pending.map(item=><ShoppingRow key={item.id} item={item} onToggle={onToggle} onDelete={onDelete} onEdit={setEditingShoppingItem} onStock={onStock}/>)}
      </div>:<div className="shopping-empty"><ShoppingCart size={25}/><strong>Sua lista está vazia</strong><span>Adicione um item ou aproveite as sugestões de reposição quando estiverem disponíveis.</span></div>}
      {purchased.length>0&&<details className="shopping-purchased">
        <summary>Comprados ({purchased.length})</summary>
        <div className="shopping-items">{purchased.map(item=><ShoppingRow key={item.id} item={item} onToggle={onToggle} onDelete={onDelete} onEdit={setEditingShoppingItem} onStock={onStock}/>)}</div>
      </details>}
    </>}
    {editingShoppingItem&&<EditShoppingItemModal item={editingShoppingItem} onClose={()=>setEditingShoppingItem(null)} onSave={(quantity,unit)=>{onEdit(editingShoppingItem,quantity,unit);setEditingShoppingItem(null);}}/>}
  </section>
}

function ShoppingRow({item,onToggle,onDelete,onEdit,onStock}:{item:ShoppingItem;onToggle:(item:ShoppingItem)=>void;onDelete:(item:ShoppingItem)=>void;onEdit:(item:ShoppingItem)=>void;onStock:(item:ShoppingItem)=>void}){
  const unit=units.includes(item.unit as Unit)?item.unit as Unit:'unidades';
  return <div className={'shopping-row '+(item.is_purchased?'purchased':'')}>
    <label className="shopping-check"><input type="checkbox" checked={item.is_purchased} onChange={()=>onToggle(item)} aria-label={(item.is_purchased?'Desmarcar ':'Marcar como comprado ')+item.name}/><span className="shopping-checkmark"/></label>
    <div className="shopping-row-name"><strong>{item.name}</strong><small>{formatQuantity(item.quantity,unit)}{item.category?' · '+item.category:''}{item.source!=='manual'?' · sugestão automática':''}</small></div>
    <div className="shopping-row-actions">
      <button type="button" className="shopping-edit" onClick={()=>onEdit(item)} aria-label={'Editar '+item.name} title="Editar quantidade e unidade"><Edit3 size={16}/></button>
      {item.is_purchased&&!item.linked_food_id&&<button type="button" onClick={()=>onStock(item)} title="Adicionar ao estoque">Adicionar ao estoque</button>}
      {item.linked_food_id&&<span className="shopping-stock-linked">No estoque</span>}
      <button type="button" className="shopping-delete" onClick={()=>onDelete(item)} aria-label={'Excluir '+item.name} title="Excluir item"><Trash2 size={16}/></button>
    </div>
  </div>
}

function EditShoppingItemModal({item,onClose,onSave}:{item:ShoppingItem;onClose:()=>void;onSave:(quantity:number,unit:Unit)=>void}){
  const[quantity,setQuantity]=useState(String(item.quantity));
  const[unit,setUnit]=useState<Unit>(units.includes(item.unit as Unit)?item.unit as Unit:'unidades');
  const valid=quantity.trim()!==''&&Number.isFinite(Number(quantity))&&Number(quantity)>0;
  return <Modal title={'Editar '+item.name} onClose={onClose}>
    <label>Quantidade<input type="number" min="0.001" step="any" value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>
    <label>Unidade<select value={unit} onChange={event=>setUnit(event.target.value as Unit)}>{units.map(option=><option key={option} value={option}>{option[0].toUpperCase()+option.slice(1)}</option>)}</select></label>
    <button type="button" className="primary full" disabled={!valid} onClick={()=>onSave(Number(quantity),unit)}>Salvar alterações</button>
  </Modal>
}

function AddFoodToShoppingModal({food,onClose,onConfirm}:{food:Food;onClose:()=>void;onConfirm:(quantity:number)=>void}){
  const[quantity,setQuantity]=useState(1);
  const step=quantityStep(food.unit);
  return <Modal title="Adicionar à lista de compras" onClose={onClose}>
    <div className="move-current"><span>Alimento</span><strong>{food.name}</strong><small>Unidade: {food.unit}</small></div>
    <label>Quantidade para comprar<input type="number" min={step} step={step} value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/></label>
    <button className="primary full" disabled={!Number.isFinite(quantity)||quantity<=0} onClick={()=>onConfirm(Number(quantity))}>Adicionar {Number.isFinite(quantity)&&quantity>0?formatQuantity(quantity,food.unit):''} à lista</button>
  </Modal>
}

function ShoppingStockModal({item,places,onClose,onConfirm}:{item:ShoppingItem;places:Place[];onConfirm:(item:ShoppingItem,placeId:string,subId:string,expiresOn:string|null)=>void;onClose:()=>void}){
  const[placeId,setPlaceId]=useState(places[0]?.id||'');
  const[expiresOn,setExpiresOn]=useState('');
  const place=places.find(p=>p.id===placeId);
  const destination=place?.subdivisions[0];
  const unit=units.includes(item.unit as Unit)?item.unit as Unit:'unidades';
  return <Modal title="Adicionar ao estoque" onClose={onClose}>
    <div className="move-current"><span>Compra concluída</span><strong>{item.name}</strong><small>{formatQuantity(item.quantity,unit)}</small></div>
    {places.length?<>
      <p className="modal-help">Escolha onde guardar o que você comprou.</p>
      <label>Local<select value={placeId} onChange={e=>setPlaceId(e.target.value)}>{places.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Validade (opcional)<input type="date" value={expiresOn} onChange={e=>setExpiresOn(e.target.value)}/></label>
      {destination?.foods.some(f=>searchKey(f.name)===searchKey(item.name)&&f.unit===unit&&(f.expires_on||'')===expiresOn)&&<p className="modal-help">Esse alimento já existe neste local com a mesma validade. A quantidade será somada ao estoque atual.</p>}
      <button className="primary full" disabled={!place||!destination} onClick={()=>onConfirm(item,placeId,destination!.id,expiresOn||null)}>Adicionar {formatQuantity(item.quantity,unit)}</button>
    </>:<>
      <p className="modal-help">Crie um local antes de adicionar esta compra ao estoque.</p>
      <button className="primary full" onClick={onClose}>Fechar</button>
    </>}
  </Modal>
}

function HouseholdModal({busy,households,activeHouseholdId,invite,joinCode,copied,onClose,onSwitch,onRename,onCreateInvite,onJoin,onJoinCodeChange,onCopy,onLeave,onCreateHousehold,currentUserId}:{busy:boolean;households:Household[];activeHouseholdId:string|null;invite:{code:string;expiresAt:string}|null;joinCode:string;copied:boolean;onClose:()=>void;onSwitch:(id:string)=>void;onRename:(id:string,name:string)=>Promise<boolean>;onCreateInvite:()=>void;onJoin:()=>void;onJoinCodeChange:(value:string)=>void;onCopy:(code:string)=>void;onLeave:(id:string)=>Promise<boolean>;onCreateHousehold:(name:string)=>Promise<boolean>;currentUserId:string|null}){
  const active=households.find(h=>h.id===activeHouseholdId);
  const canInvite=!!active;
  const[houseName,setHouseName]=useState(active?.name||'');
  const[nameEditing,setNameEditing]=useState(false);
  const[nameMessage,setNameMessage]=useState('');
  const[leaveConfirm,setLeaveConfirm]=useState(false);
  const[createHouseOpen,setCreateHouseOpen]=useState(false);
  const[newHouseName,setNewHouseName]=useState('');
  const[createHouseError,setCreateHouseError]=useState('');
  useEffect(()=>{setHouseName(active?.name||'');},[active?.name]);
  useEffect(()=>{setNameEditing(false);setNameMessage('');},[active?.id]);
  const[members,setMembers]=useState<HouseholdMember[]>([]);
  const[membersLoading,setMembersLoading]=useState(false);
  const[membersError,setMembersError]=useState('');
  useEffect(()=>{
    let current=true;
    if(!active?.id){setMembers([]);setMembersError('');return()=>{current=false};}
    setMembersLoading(true);setMembersError('');
    void (async()=>{try{
      const{data,error}=await supabase.rpc('get_household_members',{target_household_id:active.id});
      if(!current)return;
      if(error){setMembers([]);setMembersError('Não foi possível carregar os membros agora. Tente novamente.');}
      else setMembers((data||[]) as HouseholdMember[]);
    }catch{
      if(!current)return;
      setMembers([]);setMembersError('Não foi possível carregar os membros agora. Tente novamente.');
    }finally{if(current)setMembersLoading(false);}})();
    return()=>{current=false};
  },[active?.id]);
  const roleLabel=(_role:HouseholdMember['role'])=>'Membro';
  return <Modal title="Família e compartilhamento" onClose={onClose}>
    <p className="modal-help">Veja quem participa desta casa e compartilhe o estoque com as pessoas que moram com você.</p>
    {households.length>1&&<label>Casa ativa<select value={activeHouseholdId||''} disabled={busy} onChange={e=>onSwitch(e.target.value)}>{households.map(h=><option key={h.id} value={h.id}>{h.name}{h.is_personal?' · pessoal':''}</option>)}</select></label>}
    <div className="household-panel">
      <div className="household-panel-heading"><Users size={18}/><strong>{active?.name||'Sua casa'}</strong></div>
      {active&&(nameEditing?<div className="household-rename">
        <label>Nome da casa<input value={houseName} maxLength={15} onChange={event=>{setHouseName(event.target.value);setNameMessage('');}} placeholder="Ex.: Minha casa"/></label>
        <div className="household-rename-actions"><button type="button" disabled={busy} onClick={()=>{setHouseName(active?.name||'');setNameEditing(false);setNameMessage('');}}>Cancelar</button><button type="button" className="primary" disabled={busy||!houseName.trim()||houseName.trim()===active?.name} onClick={()=>{void onRename(active!.id,houseName).then(ok=>{if(ok){setNameEditing(false);setNameMessage('Nome da casa alterado com sucesso.');}});}}>Salvar nome</button></div>
      </div>:<button type="button" className="household-rename-trigger" onClick={()=>{setNameMessage('');setNameEditing(true);}}>Editar nome da casa</button>)}
      {nameMessage&&<p className="household-rename-success" role="status" aria-live="polite">✓ {nameMessage}</p>}
      <p>{active?.is_personal?'Esta é sua casa pessoal. Você pode convidar familiares para compartilhar o mesmo estoque.':'Você está vendo o estoque compartilhado desta casa.'}</p>
      <div className="household-members">
        <div className="household-members-heading"><strong>Quem está nesta casa</strong><span>{membersLoading?'Carregando…':members.length+' '+(members.length===1?'pessoa':'pessoas')}</span></div>
        {membersLoading?<div className="household-members-state">Buscando os membros da família…</div>:membersError?<div className="household-members-state error">{membersError}<button type="button" onClick={()=>{setMembersError('');setMembersLoading(true);void (async()=>{try{const{data,error}=await supabase.rpc('get_household_members',{target_household_id:active?.id});if(error){setMembersError('Não foi possível carregar os membros.');setMembers([]);}else{setMembers((data||[]) as HouseholdMember[]);setMembersError('');}}catch{setMembersError('Não foi possível carregar os membros.');setMembers([]);}finally{setMembersLoading(false);}})();}}>Tentar novamente</button></div>:members.length===0?<div className="household-members-state">Ainda não há outros membros. Gere um convite para adicionar familiares.</div>:members.map(member=><div className="household-member" key={member.user_id}><span className="household-member-avatar">{(member.display_name||member.email||'M').trim().charAt(0).toLocaleUpperCase('pt-BR')}</span><span className="household-member-details"><strong>{member.display_name||'Membro da família'}</strong><small>{member.email||'E-mail não disponível'}</small></span><span className={'household-member-role '+member.role}>{roleLabel(member.role)}</span></div>)}
      </div>
      {canInvite?<>
        <button className="primary full" disabled={busy} onClick={onCreateInvite}><Users size={16}/> {busy?'Aguarde...':'Gerar convite para familiares'}</button>
        {invite&&<div className="household-invite">
          <span>Código de convite</span>
          <div><strong>{invite.code}</strong><button type="button" onClick={()=>onCopy(invite.code)} aria-label="Copiar código de convite"><Copy size={16}/>{copied?'Copiado':'Copiar'}</button></div>
          <small>Expira em {new Date(invite.expiresAt).toLocaleDateString('pt-BR')} · até 10 usos</small>
        </div>}
      </>:<p className="household-note">Entre em uma casa para gerar um convite.</p>}
    </div>
    <div className="household-join household-create">
      {createHouseOpen? <>
        <strong>Criar uma nova casa</strong>
        <p>Crie um estoque separado para outro endereço, imóvel ou grupo familiar.</p>
        <label>Nome da casa<input value={newHouseName} maxLength={15} onChange={e=>{setNewHouseName(e.target.value);setCreateHouseError('');}} placeholder="Ex.: Casa de praia"/></label>
        {createHouseError&&<p className="form-error" role="alert">{createHouseError}</p>}
        <div className="household-rename-actions">
          <button type="button" disabled={busy} onClick={()=>{setCreateHouseOpen(false);setNewHouseName('');setCreateHouseError('');}}>Cancelar</button>
          <button type="button" className="primary" disabled={busy||!newHouseName.trim()||newHouseName.trim().length>15} onClick={()=>{void onCreateHousehold(newHouseName).then(ok=>{if(ok){setNewHouseName('');setCreateHouseOpen(false);setCreateHouseError('');}else setCreateHouseError('Não foi possível criar a casa. Tente novamente.');});}}>{busy?'Criando…':'Criar casa'}</button>
        </div>
      </>:<button type="button" className="secondary full" disabled={busy} onClick={()=>setCreateHouseOpen(true)}><Plus size={16}/> Criar outra casa</button>}
    </div>
    {active&&!(active.is_personal&&active.created_by===currentUserId&&members.length<=1)&&<div className="household-leave">
      {leaveConfirm?<div className="household-leave-confirm">
        <strong>Sair desta casa?</strong>
        <p>{active.is_personal&&active.created_by===currentUserId?'Sua casa pessoal será convertida em uma casa compartilhada para os outros membros. Seus dados pessoais e as outras casas serão mantidos.':'Você perderá acesso ao estoque e à lista desta casa. Sua conta e os dados dos outros membros continuarão preservados.'}</p>
        <div className="household-rename-actions"><button type="button" disabled={busy} onClick={()=>setLeaveConfirm(false)}>Cancelar</button><button type="button" className="danger-button" disabled={busy} onClick={()=>void onLeave(active.id).then(ok=>{if(ok){setLeaveConfirm(false);onClose();}})}>{busy?'Saindo…':'Confirmar saída'}</button></div>
      </div>:<button type="button" className="household-leave-trigger" disabled={busy} onClick={()=>setLeaveConfirm(true)}>Sair desta casa</button>}
    </div>}
    <div className="household-join">
      <strong>Entrar em outra casa</strong>
      <p>Digite o código de convite que um familiar compartilhou com você.</p>
      <label>Código<input value={joinCode} onChange={e=>onJoinCodeChange(e.target.value.toUpperCase())} placeholder="Ex.: A1B2C3D4E5" autoComplete="off"/></label>
      <button className="primary full" disabled={busy||joinCode.trim().length<6} onClick={onJoin}>{busy?'Aguarde...':'Entrar na casa'}</button>
    </div>
  </Modal>
}

function Empty({title,text,action,actionLabel}:{title:string;text:string;action?:()=>void;actionLabel?:string}){
  return <div className="empty"><PackagePlus size={30}/><h3>{title}</h3><p>{text}</p>{action&&<button className={actionLabel==='Limpar busca'?'secondary':'primary'} onClick={action}>{actionLabel==='Limpar busca'?<X size={18}/>:<Plus size={18}/>} {actionLabel||'Adicionar alimento'}</button>}</div>
}

type ImportRow={name:string;quantity:number;unit:Unit;expires_on:string|null};
function ImportInventoryModal({places,onClose,onImport}:{places:Place[];onClose:()=>void;onImport:(placeId:string,rows:ImportRow[])=>Promise<void>;}) {
  const [placeId,setPlaceId]=useState(places[0]?.id||'');
  const [text,setText]=useState('');
  const [fileName,setFileName]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const parse=()=>{
    const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!lines.length)return [] as ImportRow[];
    const first=lines[0].split(/[\t;,]/).map(value=>value.trim().toLowerCase());
    const hasHeader=first.some(value=>['nome','produto','alimento','name','product','item'].includes(value));
    const header=hasHeader?first:[];
    const data=hasHeader?lines.slice(1):lines;
    return data.map(line=>{
      const values=line.includes('\t')?line.split('\t'):line.includes(';')?line.split(';'):line.split(',');
      const get=(keys:string[],fallback:number)=>{const index=header.findIndex(value=>keys.includes(value));return (values[index>=0?index:fallback]||'').trim()};
      const name=get(['nome','produto','alimento','name','product','item'],0);
      if(!name)return null;
      const rawQuantity=get(['quantidade','quantity','qty'],1);
      const quantityText=rawQuantity.replace(',','.');
      const quantity=rawQuantity&&Number.isFinite(Number(quantityText))?Math.max(0,Number(quantityText)):1;
      const rawUnit=get(['unidade','unit'],2).toLowerCase();
      const unitMap:Record<string,Unit>={'unidade':'unidades','unidades':'unidades','unit':'unidades','units':'unidades','un':'unidades','pacote':'pacotes','pacotes':'pacotes','lata':'latas','latas':'latas','garrafa':'garrafas','garrafas':'garrafas','saco':'sacos','sacos':'sacos','caixa':'caixas','caixas':'caixas','pote':'potes','potes':'potes','bandeja':'bandejas','bandejas':'bandejas','kg':'kg','quilo':'kg','quilos':'kg','g':'g','gramas':'g','l':'L','litro':'L','litros':'L','ml':'ml'};
      const unit=unitMap[rawUnit]||'unidades';
      const rawExpiry=get(['validade','vencimento','expires_on','expiry','expiry date'],3);
      let expires_on:string|null=null;
      if(/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry))expires_on=rawExpiry;
      else if(/^\d{2}\/\d{2}\/\d{4}$/.test(rawExpiry)){const [month,day,year]=rawExpiry.split('/');expires_on=year+'-'+month+'-'+day;}
      return {name,quantity,unit,expires_on};
    }).filter((row):row is ImportRow=>!!row);
  };
  const rows=parse();
  const readFile=(file?:File)=>{
    if(!file)return;
    if(!/\.(csv|txt)$/i.test(file.name)){setError('Use um arquivo CSV ou TXT. Para Excel, salve como CSV ou copie e cole as células aqui.');return;}
    const reader=new FileReader();
    reader.onload=()=>{setText(String(reader.result||''));setFileName(file.name);setError('');};
    reader.onerror=()=>setError('Não foi possível ler esse arquivo.');
    reader.readAsText(file);
  };
  const submit=async()=>{if(!placeId||!rows.length){setError('Escolha um local e informe pelo menos um produto.');return;}setBusy(true);setError('');try{await onImport(placeId,rows);}catch{setError('Não foi possível concluir a importação. Confira sua conexão e tente novamente.');}finally{setBusy(false);}};
  return <Modal title="Importar lista para o estoque" onClose={onClose}>
    <p className="modal-help">Cole uma lista copiada do Excel ou importe um arquivo CSV/TXT. Formato por linha: produto, quantidade, unidade e validade (opcional).</p>
    <label>Local de destino<select value={placeId} onChange={event=>setPlaceId(event.target.value)}>{places.map(place=><option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
    <label>Arquivo CSV ou TXT<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={event=>readFile(event.target.files?.[0])}/></label>
    {fileName&&<p className="field-help">Arquivo carregado: {fileName}</p>}
    <label>Lista de produtos<textarea rows={7} value={text} onChange={event=>{setText(event.target.value);setError('');}} placeholder={'Arroz, 2, kg\nLeite, 3, unidades\nFeijão\n\nOu copie diretamente as células do Excel.'}/></label>
    <p className="field-help">{rows.length} {rows.length===1?'produto identificado':'produtos identificados'}. Quantidade e unidade são opcionais; quando ausentes, será usada quantidade 1 e unidade “unidades”.</p>
    {error&&<p className="auth-note" role="alert">{error}</p>}
    <button className="primary full" disabled={busy||!rows.length||!placeId} onClick={()=>void submit()}>{busy?'Importando...':'Importar '+rows.length+' '+(rows.length===1?'produto':'produtos')}</button>
  </Modal>;
}

function FoodModal({data,placeId,subId,places,recentFoods,onClose,onSave,onAddToExisting}:{data?:Food;placeId:string;subId:string;places:Place[];recentFoods:RecentFood[];onClose:()=>void;onSave:(placeId:string,subId:string,d:Omit<Food,'id'>,daysPerUnit?:number)=>void;onAddToExisting:(placeId:string,subId:string,existingId:string,amount:number,unit:Unit)=>void}){
  const[name,setName]=useState(data?.name||'');
  const[quantity,setQuantity]=useState(data?.quantity ?? 1);
  const[unit,setUnit]=useState<Unit>(data?.unit||'unidades');
  const[expiresOn,setExpiresOn]=useState(data?.expires_on||'');
  const[programConsumption,setProgramConsumption]=useState(false);
  const[daysPerUnit,setDaysPerUnit]=useState(7);
  const[chosenPlace,setChosenPlace]=useState(placeId);
  const[chosenSub,setChosenSub]=useState(subId||places.find(p=>p.id===placeId)?.subdivisions[0]?.id||'');
  const currentPlace=places.find(p=>p.id===chosenPlace);
  const destination=currentPlace?.subdivisions[0];
  const existingFoods=destination?.foods||[];
  const duplicateFood=existingFoods.find(f=>f.id!==data?.id&&searchKey(f.name.trim())===searchKey(name.trim())&&f.unit===unit&&(f.expires_on||'')===expiresOn);
  const duplicate=!!duplicateFood;
  const quantityStep=unit==='kg'||unit==='L'?0.1:1;
  const canSave=!!name.trim()&&!!chosenPlace&&!!chosenSub&&Number.isFinite(quantity)&&quantity>=0;
  const canMerge=!!duplicateFood&&duplicateFood.unit===unit&&quantity>0;
  return <Modal title={data?'Editar alimento':'Novo alimento'} onClose={onClose}>
    {!data&&(!placeId||!places.some(p=>p.id===placeId))&&<div className="destination-fields">
      <div className="destination-title"><span>Onde ele fica?</span><small>Escolha o local.</small></div>
      <div className="row">
        <label>Local<select value={chosenPlace} onChange={e=>{const nextPlace=places.find(p=>p.id===e.target.value);setChosenPlace(e.target.value);setChosenSub(nextPlace?.subdivisions[0]?.id||'')}}><option value="">Selecione...</option>{places.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
    </div>}
    {!data&&placeId&&places.some(p=>p.id===placeId)&&<p className="food-destination-note"><Check size={14}/> Será adicionado a <strong>{places.find(p=>p.id===placeId)?.name}</strong>.</p>}
    <label>Nome do alimento<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Arroz"/></label>
    {!data&&recentFoods.length>0&&!name&&<div className="recent-foods"><span>Adicionados recentemente</span><div>{recentFoods.slice(0,6).map(f=><button key={f.name} onClick={()=>{setName(f.name);setUnit(f.unit)}}>{f.name}</button>)}</div></div>}
    {duplicate&&<div className="duplicate-note"><strong>“{duplicateFood?.name}” já está neste local.</strong><span>Você pode somar a nova quantidade ao estoque existente.</span>{canMerge&&<button type="button" onClick={()=>onAddToExisting(chosenPlace,chosenSub,duplicateFood!.id,quantity,unit)}><Plus size={15}/> Somar {formatQuantity(quantity,unit)}</button>}</div>}
    <label>Validade (opcional)<input type="date" value={expiresOn} onChange={e=>setExpiresOn(e.target.value)} aria-label="Data de validade do alimento"/><small className="field-help">Se houver várias embalagens com datas diferentes, cadastre cada lote separadamente.</small></label>
    <div className="row">
      <label>Quantidade<div className="number"><button type="button" aria-label="Diminuir quantidade" onClick={()=>setQuantity(Math.max(0,Number((quantity-quantityStep).toFixed(3))))}><Minus/></button><input type="number" min="0" step={quantityStep} value={quantity} onChange={e=>{const value=Number(e.target.value);setQuantity(Number.isFinite(value)?Math.max(0,value):0)}} aria-label="Quantidade" /><button type="button" aria-label="Aumentar quantidade" onClick={()=>setQuantity(Number((quantity+quantityStep).toFixed(3)))}><Plus/></button></div></label>
      <label>Unidade<select value={unit} onChange={e=>setUnit(e.target.value as Unit)}>{units.map(u=><option key={u}>{u}</option>)}</select></label>
    </div>
    {!data&&<div className="destination-fields consumption-setup"><label className="consumption-toggle"><input type="checkbox" checked={programConsumption} onChange={e=>setProgramConsumption(e.target.checked)}/> Programar consumo esperado</label>{programConsumption&&<><p className="modal-help">Informe quantos dias uma unidade costuma durar. Com {quantity} {unit}, a duração estimada será de {Math.round(quantity*daysPerUnit)} dias.</p><label>Quantos dias dura uma unidade?<input type="number" min="1" max="365" step="1" value={daysPerUnit} onChange={e=>setDaysPerUnit(Number(e.target.value))}/></label></>}</div>}
    <button className="primary full" disabled={!canSave||(programConsumption&&(!Number.isInteger(daysPerUnit)||daysPerUnit<1||daysPerUnit>365))} onClick={()=>onSave(chosenPlace,currentPlace?.subdivisions[0]?.id||chosenSub,{name:name.trim(),quantity,unit,expires_on:expiresOn||null},programConsumption?daysPerUnit:undefined)}>{data?'Salvar alterações':'Adicionar alimento'}</button>
  </Modal>
}

function MoveModal({data,places,onClose,onMove}:{data:{place:string;sub:string;food:Food};places:Place[];onClose:()=>void;onMove:(fromPlaceId:string,fromSubId:string,foodId:string,toPlaceId:string,toSubId:string)=>void}){
  return <Modal title="Mover alimento" onClose={onClose}>
    <div className="move-current"><span>Movendo</span><strong>{data.food.name}</strong><small>{formatQuantity(data.food.quantity,data.food.unit)} · {places.find(p=>p.id===data.place)?.name}</small></div>
    <p className="modal-help move-help">Escolha o local de destino.</p>
    <div className="move-list">
      {places.map(p=>{
        const destination=p.subdivisions[0];
        const same=p.id===data.place;
        return <div className="move-place" key={p.id}>
          <div className="move-place-head"><strong>{p.name}</strong></div>
          <div className="move-sub-list">
            <button className={same?'current':''} disabled={same||!destination} onClick={()=>destination&&onMove(data.place,data.sub,data.food.id,p.id,destination.id)}>
              <span>{p.name}</span>{same?<small>Atual</small>:<ChevronRight size={16}/>}
            </button>
          </div>
        </div>;
      })}
    </div>
  </Modal>
}

function PlaceModal({places,initialEditId,onClose,onSave,onDelete}:{places:Place[];initialEditId?:string|null;onClose:()=>void;onSave:(name:string,id?:string)=>Promise<boolean>;onDelete:(id:string)=>Promise<boolean>}){
  const initialEdit=places.find(p=>p.id===initialEditId)||null;
  const[name,setName]=useState(initialEdit?.name||'');
  const[edit,setEdit]=useState<Place|null>(initialEdit);
  const[adding,setAdding]=useState(!places.length&&!initialEdit);
  const[deleteCandidate,setDeleteCandidate]=useState<Place|null>(null);
  const[deleting,setDeleting]=useState(false);
  const startAdd=()=>{setEdit(null);setName('');setAdding(true)};
  const goBack=()=>{setEdit(null);setName('');setAdding(false);setDeleteCandidate(null)};
  const save=async()=>{if(await onSave(name,edit?.id))goBack()};
  const confirmDelete=async()=>{
    if(!deleteCandidate||deleting)return;
    setDeleting(true);
    try{await onDelete(deleteCandidate.id)}finally{setDeleting(false);setDeleteCandidate(null)}
  };
  return <Modal title={deleteCandidate?'Confirmar exclusão':edit?'Editar local':adding?'Novo local':'Seus locais'} onClose={onClose}>
    {deleteCandidate?(
      <div className="delete-confirm">
        <div className="delete-confirm-icon"><Trash2 size={22}/></div>
        <h3>Excluir “{deleteCandidate.name}”?</h3>
        <p>Os alimentos cadastrados nesse local também serão removidos do seu estoque. Quer continuar?</p>
        <div className="delete-confirm-actions">
          <button className="secondary" disabled={deleting} onClick={()=>setDeleteCandidate(null)}>Cancelar</button>
          <button className="danger" disabled={deleting} onClick={()=>void confirmDelete()}>{deleting?'Excluindo…':'Sim, excluir local'}</button>
        </div>
      </div>
    ):!edit&&!adding?(
      <>
        <p className="modal-help">Organize sua casa por locais como geladeira, freezer, despensa ou armário.</p>
        {places.length?(
          <div className="manage-list">
            {places.map(p=>(
              <div key={p.id}>
                <span>
                  <strong>{p.name}</strong>
                </span>
                <div>
                  <button onClick={()=>{setEdit(p);setName(p.name)}} title={'Renomear '+p.name} aria-label={'Renomear '+p.name}><Edit3 size={16}/></button>
                  <button className="danger" onClick={()=>setDeleteCandidate(p)} title={'Excluir '+p.name} aria-label={'Excluir '+p.name}><Trash2 size={16}/></button>
                </div>
              </div>
            ))}
          </div>
        ):(
          <div className="manage-empty">
            <div className="no-places-icon"><Box size={20}/></div>
            <strong>Nenhum local criado</strong>
            <span>Comece pelo lugar onde seus alimentos ficam.</span>
          </div>
        )}
        <button className="primary full" onClick={startAdd}><Plus size={18}/> Novo local</button>
      </>
    ):(
      <>
        {places.length>0&&<button className="back modal-back" onClick={goBack}>← Voltar aos locais</button>}
        <label>Nome do local<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Geladeira"/></label>
        <button className="primary full" disabled={!name.trim()} onClick={save}>{edit?'Salvar alterações':'Criar local'}</button>
      </>
    )}
  </Modal>
}
function SubModal({data,onClose,onSave,onDelete}:{data?:Sub;onClose:()=>void;onSave:(name:string)=>Promise<boolean>;onDelete:(id:string)=>Promise<boolean>}){
  const[name,setName]=useState(data?.name||'');
  return <Modal title={data?'Editar subdivisão':'Nova subdivisão'} onClose={onClose}>
    <p className="modal-help">{data?'Altere o nome desta divisão.':'Crie uma divisão como “Gaveta de cima”, “Porta” ou “Prateleira 2”.'}</p>
    <label>Nome<input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="Ex.: Gaveta de cima"/></label>
    <button className="primary full" disabled={!name.trim()} onClick={async()=>{await onSave(name)}}>{data?'Salvar alterações':'Criar subdivisão'}</button>
    {data&&data.foods.length===0&&<button className="text-danger" onClick={async()=>{if(await onDelete(data.id))onClose()}}><Trash2 size={15}/> Excluir subdivisão</button>}
  </Modal>
}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose()};
    document.addEventListener('keydown',onKey);
    return()=>document.removeEventListener('keydown',onKey);
  },[onClose]);
  return <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button onClick={onClose} aria-label="Fechar"><X/></button></div>{children}</div></div>
}

export default App;