import React from "react";
import moment from "moment";
import {
  ActivityIndicator,
  View,
  Text,
  TouchableView,
  styled
} from "bappo-components";
import { AutoSizer, MultiGrid } from "react-virtualized";
import { setUserPreferences, getUserPreferences } from "user-preferences";
import {
  dateFormat,
  datesToArray,
  getEntryFormFields,
  updateRosterEntryRecords,
  deleteRosterEntryRecords,
  projectAssignmentsToOptions
} from "roster-utils";
import SingleRoster from "single-roster";

const dateRangeOptions = [
  {
    id: "6",
    label: "6 weeks"
  },
  {
    id: "12",
    label: "12 weeks"
  },
  {
    id: "24",
    label: "24 weeks"
  },
  {
    id: "52",
    label: "52 weeks"
  }
];

// Rows are sorted based on consultant name
class Roster extends React.Component {
  // Dimensions
  CELL_DIMENSION = 45;
  CELL_DIMENSION_LARGE = 120;
  CONSULTANT_CELL_WIDTH = 160;

  highestRowIndex = 0;
  isLoading = false;
  data = {
    requests: {}
  };

  constructor(props) {
    super(props);

    this.state = {
      costCenter: null,
      weeks: "12",
      startDate: moment().startOf("week"),
      endDate: moment()
        .startOf("week")
        .add(12, "weeks"),
      initializing: true,
      mode: "small",
      entryList: [],
      commonProjects: [],
      consultants: [],
      projectAssignments: [],
      consultantOffset: 0
    };
  }

  async componentDidMount() {
    // load request resrouces
    const requests = await this.props.$models.ResourceRequest.findAll({
      where: {}
    });

    // Store requests in this.data
    this.data.requests = {};
    requests.forEach(r => {
      if (!this.data.requests[r.consultant_id]) {
        this.data.requests[r.consultant_id] = [];
      }
      this.data.requests[r.consultant_id].push(r);
    });

    const prefs = await getUserPreferences(
      this.props.$global.currentUser.id,
      this.props.$models
    );
    let { costCenter_id, includeCrossTeamConsultants } = prefs;
    includeCrossTeamConsultants = includeCrossTeamConsultants === "true";
    this.initialize(
      costCenter_id,
      this.state.startDate,
      undefined,
      includeCrossTeamConsultants
    );
  }

  reload = () =>
    this.initialize(
      this.state.costCenter && this.state.costCenter.id,
      this.state.startDate
    );

  // Initial data initializing and configuration
  initialize = async (
    costCenter_id,
    startDate,
    endDate = moment(startDate).add(12, "weeks"),
    includeCrossTeamConsultants
  ) => {
    const { $models } = this.props;

    if (!this.state.initializing) await this.setState({ initializing: true });

    // Get date array, to put at first of entryList
    const dateArray = datesToArray(startDate, endDate).map(date => {
      let labelFormat = "DD";
      if (date.day() === 1) labelFormat = "MMM DD";

      return {
        formattedDate: date.format(labelFormat),
        weekday: date.format("ddd"),
        isWeekend: date.day() === 6 || date.day() === 0,
        date
      };
    });
    dateArray.unshift("");

    const consultantQuery = {
      active: true
    };
    if (costCenter_id) consultantQuery.costCenter_id = costCenter_id;

    const promises = [
      $models.Consultant.findAll({
        where: consultantQuery
      }),
      $models.Project.findAll({
        where: {
          projectType: {
            $in: ["4", "5", "6", "7"]
          }
        }
      }),
      $models.Probability.findAll({})
    ];

    if (costCenter_id) {
      promises.push($models.CostCenter.findById(costCenter_id));
    }

    let [
      consultants,
      commonProjects,
      probabilities,
      costCenter
    ] = await Promise.all(promises);

    this.data.probabilityOptions = probabilities.reverse().map((p, index) => ({
      id: p.id,
      label: p.name,
      pos: index
    }));

    if (includeCrossTeamConsultants && costCenter) {
      const projects = await $models.Project.findAll({
        where: { profitCentre_id: costCenter.profitCentre_id, active: true }
      });
      const projectIds = projects.map(p => p.id);
      const projectAssignments = await $models.ProjectAssignment.findAll({
        where: {
          project_id: { $in: projectIds }
        },
        include: [{ as: "consultant" }]
      });
      const otherConsultants = projectAssignments.map(pa => pa.consultant);
      const consultantMap = {};
      consultants.forEach(c => (consultantMap[c.id] = c));
      otherConsultants.forEach(c => {
        if (!consultantMap[c.id]) consultantMap[c.id] = c;
      });
      consultants = Object.values(consultantMap);
    }

    consultants.sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    this.setState(
      {
        entryList: [dateArray],
        costCenter,
        consultants,
        consultantCount: consultants.length,
        consultantOffset: 0,
        commonProjects,
        startDate,
        endDate,
        includeCrossTeamConsultants
      },
      () => this.loadData()
    );
  };

  loadData = async () => {
    const {
      startDate,
      endDate,
      consultants,
      consultantOffset,
      projectAssignments,
      entryList
    } = this.state;
    const { RosterEntry, ProjectAssignment } = this.props.$models;

    if (this.isLoading) return;
    this.isLoading = true;

    const newConsultantOffset = consultantOffset + 10;
    const newConsultants = consultants.slice(
      consultantOffset,
      newConsultantOffset
    );

    // Build map between id and consultant
    const consultantMap = {};
    newConsultants.forEach(c => {
      consultantMap[c.id] = c;
    });
    const newConsultantIds = newConsultants.map(c => c.id);

    const promises = [];

    // Fetch Project Assignments
    promises.push(
      ProjectAssignment.findAll({
        where: {
          consultant_id: {
            $in: newConsultantIds
          }
        },
        include: [{ as: "project" }],
        limit: 1000
      })
    );

    // Fetch roster entries
    promises.push(
      RosterEntry.findAll({
        where: {
          date: {
            $between: [startDate.format(dateFormat), endDate.format(dateFormat)]
          },
          consultant_id: {
            $in: newConsultantIds
          }
        },
        include: [{ as: "project" }, { as: "probability" }],
        limit: 1000
      }).then(rosterEntries => {
        const tempMap = {};

        // Initialize: insert date and consultant_id
        const datesArr = datesToArray(startDate, endDate, true).map(date => ({
          date
        }));
        newConsultantIds.forEach(cid => {
          tempMap[cid] = datesArr;
        });

        rosterEntries.forEach(entry => {
          const entryIndex = moment(entry.date).diff(startDate, "days");
          tempMap[entry.consultant_id][entryIndex] = entry;
        });

        // Insert consultant name at first of roster entry array
        const newEntryList = Object.entries(tempMap).map(([key, value]) => {
          const consultant = consultantMap[key];
          return [consultant].concat(value);
        });

        // Sorting based on consultant name
        newEntryList.sort((a, b) => {
          if (a[0].name < b[0].name) return -1;
          if (a[0].name > b[0].name) return 1;
          return 0;
        });

        return newEntryList;
      })
    );

    const [newProjectAssignments, newEntryList] = await Promise.all(promises);

    this.setState(
      {
        initializing: false,
        entryList: entryList.concat(newEntryList),
        projectAssignments: projectAssignments.concat(newProjectAssignments),
        consultantOffset: newConsultantOffset
      },
      () => {
        // Fetch data of next 10 consultants if needed
        this.isLoading = false;

        this.gridRef.recomputeGridSize();
        if (newConsultantOffset < this.highestRowIndex) {
          this.loadData();
        }
      }
    );
  };

  getConsultantAssignments = consultantId => {
    const { commonProjects, projectAssignments } = this.state;
    const hisProjectAssignments = projectAssignments.filter(
      pa => pa.consultant_id === consultantId
    );

    return projectAssignmentsToOptions(hisProjectAssignments, commonProjects);
  };

  // Bring up a popup asking which cost centre and start time
  setFilters = async () => {
    const { $models, $popup } = this.props;

    const costCenters = await $models.CostCenter.findAll({
      limit: 1000
    });
    const costCenterOptions = costCenters.map(cc => ({
      id: cc.id,
      label: cc.name
    }));

    $popup.form({
      fields: [
        {
          name: "costCenterId",
          label: "Cost Center",
          type: "FixedList",
          properties: {
            options: costCenterOptions
          }
        },
        {
          name: "startDate",
          label: "Start Date",
          type: "Date",
          properties: {}
        },
        {
          name: "weeks",
          label: "Date Range",
          type: "FixedList",
          properties: {
            options: dateRangeOptions
          }
        },
        {
          name: "includeCrossTeamConsultants",
          type: "Checkbox",
          label: "Include cross-team consultants"
        }
      ],
      initialValues: {
        costCenterId: this.state.costCenter && this.state.costCenter.id,
        startDate: this.state.startDate || moment().format(dateFormat),
        weeks: this.state.weeks,
        includeCrossTeamConsultants: this.state.includeCrossTeamConsultants
      },
      onSubmit: async ({
        costCenterId,
        startDate,
        weeks,
        includeCrossTeamConsultants
      }) => {
        const endDate = moment(startDate).add(weeks, "weeks");
        this.setState({
          weeks,
          projectAssignments: [],
          includeCrossTeamConsultants
        });
        this.highestRowIndex = 0;
        this.isLoading = false;
        this.initialize(
          costCenterId,
          moment(startDate),
          endDate,
          includeCrossTeamConsultants
        );

        setUserPreferences(this.props.$global.currentUser.id, $models, {
          costCenter_id: costCenterId,
          includeCrossTeamConsultants
        });
      }
    });
  };

  setDisplayMode = mode =>
    this.setState({ mode }, () => this.gridRef.recomputeGridSize());

  cellRenderer = ({ columnIndex, key, rowIndex, style }) => {
    const { entryList, mode } = this.state;

    if (rowIndex > this.highestRowIndex) {
      this.highestRowIndex = rowIndex;
    }

    if (!entryList[rowIndex]) {
      this.loadData();
    }

    const entry = entryList[rowIndex] && entryList[rowIndex][columnIndex];

    let backgroundColor = "#f8f8f8";
    let label;

    if (rowIndex === 0) {
      // Render date label cell
      let color = "black";
      if (entry.isWeekend) color = "lightgrey";
      return (
        <Label
          key={key}
          style={style}
          backgroundColor={backgroundColor}
          color={color}
        >
          <div>{entry.weekday}</div>
          <div>{entry.formattedDate}</div>
        </Label>
      );
    } else if (columnIndex === 0) {
      // Render consultant label cell
      const consultantName =
        entry.name || this.state.consultants[rowIndex - 1].name;

      // Change background color if external consultant
      backgroundColor = "white";
      if (
        this.state.costCenter &&
        entry.costCenter_id !== this.state.costCenter.id
      ) {
        backgroundColor = "#f8f8f8";
      }

      return (
        <ClickLabel
          key={key}
          style={style}
          backgroundColor={backgroundColor}
          onClick={() => this.handleClickConsultant(entry)}
        >
          {consultantName}
        </ClickLabel>
      );
    }

    // Apply style when there are resource requests
    const entryMoment = moment(entry.date);
    const consultant_id = entryList[rowIndex][0].id;
    const requests = this.data.requests[consultant_id];
    if (
      requests &&
      requests.find(
        r =>
          entryMoment.isSameOrAfter(moment(r.beginDate)) &&
          entryMoment.isSameOrBefore(moment(r.endDate))
      )
    ) {
      style.border = "1px solid red";
    }

    // Render roster entry cell
    if (entry.project_id) {
      backgroundColor =
        entry.project.backgroundColour || entry.probability.backgroundColor;
      label =
        mode === "large"
          ? entry.project.name
          : entry.project.key || entry.project.name;
      if (mode === "small" && label.length > 5) label = label.slice(0, 5);
    }

    // Apply weekend cell style
    const { isWeekend } = this.state.entryList[0][columnIndex];

    return (
      <Cell
        key={key}
        style={style}
        backgroundColor={backgroundColor}
        isWeekend={isWeekend}
        onPress={() => this.openEntryForm(rowIndex, columnIndex, entry)}
      >
        {label}
      </Cell>
    );
  };

  handleClickConsultant = consultant => {
    const projectOptions = this.getConsultantAssignments(consultant.id);

    this.props.$popup.open(
      <SingleRoster
        {...this.props}
        consultant={consultant}
        projectOptions={projectOptions}
        onUpdate={() => this.reloadConsultantData(consultant.id)}
      />,
      {
        style: {
          width: Infinity,
          height: Infinity
        },
        title: `${consultant.name}'s Roster`,
        headerLeftTitle: "Back"
      }
    );
  };

  openEntryForm = async (rowIndex, columnIndex, entry) => {
    const { consultants, entryList } = this.state;
    const consultant = consultants[rowIndex - 1];
    const date = entryList[0][columnIndex].date.format(dateFormat);
    const projectOptions = this.getConsultantAssignments(consultant.id);

    this.props.$popup.form({
      objectKey: "RosterEntry",
      fields: getEntryFormFields(projectOptions, this.data.probabilityOptions),
      title: `${consultant.name}, ${date}`,
      initialValues: {
        ...entry,
        consultant_id: consultant.id,
        startDate: date,
        endDate: date,
        weekdayFrom: "1",
        weekdayTo: "5"
      },
      onSubmit: this.updateRosterEntry
    });
  };

  updateRosterEntry = async data => {
    const consultant = this.state.consultants.find(
      c => c.id === data.consultant_id
    );

    const payload = {
      data,
      consultant,
      operatorName: this.props.$global.currentUser.name,
      $models: this.props.$models
    };

    if (data.project_id) await updateRosterEntryRecords(payload);
    else await deleteRosterEntryRecords(payload);

    await this.reloadConsultantData(data.consultant_id);
  };

  reloadConsultantData = async consultant_id => {
    const { startDate, endDate, consultants } = this.state;

    const rosterEntries = await this.props.$models.RosterEntry.findAll({
      where: {
        date: {
          $between: [startDate.format(dateFormat), endDate.format(dateFormat)]
        },
        consultant_id
      },
      include: [{ as: "project" }, { as: "probability" }],
      limit: 1000
    });

    const rowIndex = consultants.findIndex(c => c.id === consultant_id);
    const consultant = consultants[rowIndex];

    const newEntriesArr = [];
    rosterEntries.forEach(entry => {
      const entryIndex = moment(entry.date).diff(startDate, "days");
      newEntriesArr[entryIndex] = entry;
    });
    newEntriesArr.unshift(consultant);

    this.setState(
      ({ entryList }) => {
        const newEntryList = entryList.slice();
        newEntryList[rowIndex + 1] = newEntriesArr;
        return { entryList: newEntryList, initializing: false };
      },
      () => this.gridRef.recomputeGridSize({ rowIndex })
    );
  };

  columnWidthGetter = ({ index }) => {
    const columnWidth =
      this.state.mode === "small"
        ? this.CELL_DIMENSION
        : this.CELL_DIMENSION_LARGE;
    return index === 0 ? 160 : columnWidth;
  };

  render() {
    const { initializing, consultantCount, costCenter, entryList } = this.state;
    console.log(entryList);

    if (initializing) {
      return <ActivityIndicator style={{ flex: 1 }} />;
    }

    return (
      <Container>
        <HeaderContainer>
          <HeaderSubContainer>
            <Heading>
              Cost center: {(costCenter && costCenter.name) || "all"}
            </Heading>
            <TextTouchableView onPress={this.setFilters}>
              filters
            </TextTouchableView>
            <TextTouchableView onPress={this.reload}>reload</TextTouchableView>
          </HeaderSubContainer>
          <HeaderSubContainer>
            <Heading>Cell size:</Heading>
            <TextTouchableView onPress={() => this.setDisplayMode("large")}>
              large
            </TextTouchableView>
            <TextTouchableView onPress={() => this.setDisplayMode("small")}>
              small
            </TextTouchableView>
          </HeaderSubContainer>
        </HeaderContainer>
        <BodyContainer>
          <AutoSizer>
            {({ height, width }) => (
              <MultiGrid
                width={width}
                height={height}
                fixedColumnCount={1}
                fixedRowCount={1}
                cellRenderer={this.cellRenderer}
                columnCount={entryList[0].length}
                columnWidth={this.columnWidthGetter}
                rowCount={consultantCount + 1}
                rowHeight={this.CELL_DIMENSION}
                ref={ref => (this.gridRef = ref)}
              />
            )}
          </AutoSizer>
        </BodyContainer>
      </Container>
    );
  }
}

export default Roster;

const Container = styled(View)`
  flex: 1;
  flex-direction: column;
`;

const HeaderContainer = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin: 20px;
`;

const HeaderSubContainer = styled.div`
  display: flex;
`;

const Heading = styled(Text)`
  font-size: 18px;
`;

const BodyContainer = styled.div`
  flex: 1;
  margin-right: 15px;
  margin-bottom: 15px;
`;

const TextTouchableView = styled(TouchableView)`
  color: grey;
  margin-left: 10px;
`;

const baseStyle = `
  margin-left: 2px;
  margin-right: 2px;
  justify-content: center;
  align-items: center;
  box-sizing: border-box;
  font-size: 12px;
`;

const Label = styled.div`
  ${baseStyle};
  display: flex;
  flex-direction: column;
  color: ${props => props.color || "black"};
`;

const ClickLabel = styled(Label)`
  &:hover {
    cursor: pointer;
    opacity: 0.7;
  }
  background-color: ${props => props.backgroundColor};
`;

const Cell = styled(TouchableView)`
  ${baseStyle}
  
  background-color: ${props =>
    props.isWeekend ? "white" : props.backgroundColor};

  border: 1px solid #eee;

  ${props => (props.blur ? "filter: blur(3px); opacity: 0.5;" : "")};
`;