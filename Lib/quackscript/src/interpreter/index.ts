import { DataTypeUtils } from '../utils/dataTypes/dataTypeUtils';
import { ControlFlowException } from '../exception/ControlFlowException';
import { RuntimeException } from '../exception/RuntimeException';
import Lexer from '../lexer';
import Parser from '../parser';
import { 
    AccessorExpressionNode,
    AssignmentNode, BinaryExpressionNode, BooleanLiteralNode, CodeBlockNode,  DeclarationNode, ExpressionNode,
    FuncCallNode, FuncDeclarationNode, GenericFuncDeclarationNode, IdentifierNode,
    IfStatementNode,
    ImportStatementNode,
    InternalFuncDeclarationNode, ModuleNode, NothingLiteralNode, NumberLiteralNode, OptionalDataType, ReturnStatementNode,
    StatementNode, 
    TextLiteralNode} from '../parser/types';
import { executeInternalFunc } from '../stdLibrary/standardLibrary';
import { System } from '../system';
import { Memory } from './memory';
import { State } from './state';
import { OptionalMemoryValue, Value } from './types';
import { StaticPrimitiveAttributes } from './staticPrimitiveAttributes';

// TODO - make a stdout to output
export default class Interpreter {

    public _memory;
    private _parser: Parser;
    private _lexer: Lexer;
    private _system: System;
    private _state: State;
    private _code: string | null = null;

    public constructor(
        stdout?:System['stdout'],
        stderr?:System['stderr'],
        loadFile?: System['loadFile']
    ){
        this._state = new State();
        this._memory = new Memory();
        this._system = new System(stdout, stderr, loadFile);
        this._lexer = new Lexer();
        this._parser = new Parser();
    }

    public execute(tree: ModuleNode, code?: string) {
        this._memory.clearMemory();
        this._code = code ?? null;
        try {
            this.executeModule(tree);
        } catch (er) {
            console.log(er);
            if (er instanceof RuntimeException) {
                this._system.stderr(er.toString());
                return;
            }
            throw er;
        }
        this._memory.printMemory();
    }

    public executeModule(moduleNode: ModuleNode){
        const modulesImported = this.executeAllTopImports(moduleNode);
        const importedModulesCounts = modulesImported.length;
        const statementsToExecute = moduleNode.statements.splice(importedModulesCounts);

        for (const statement of statementsToExecute) {
            const output = this.executeStatement(statement);
            if (output && output.type !== 'NothingLiteral'){
                this._system.stdout(DataTypeUtils.convertValueToText(output).value);
            }
        }
    }

    /**
     * Executes all the import statements until if find a non import statement
     */
    public executeAllTopImports(moduleNode: ModuleNode): Array<ImportStatementNode>{
        const importedModules:Array<ImportStatementNode> = [];

        for (const statement of moduleNode.statements) {
            if (statement.body.type !== 'ImportStatement') {
                return importedModules;
            }
            this.executeImportNode(statement.body as ImportStatementNode);
            importedModules.push(statement.body as ImportStatementNode);
        }

        return importedModules;
    }

    public executeImportNode(importNode: ImportStatementNode) {
        const moduleCode = this._system.loadFile(importNode.value.value);
        const tokens = this._lexer.convertToTokens(moduleCode);
        const tree = this._parser.parse(tokens);
        this.executeModule(tree);
    }

    public executeCodeBlock(block: CodeBlockNode) {
        for (const statement of block.body) {
            const outcome = this.executeStatement(statement);
            if (statement.body.type === 'ReturnStatement') {
                throw new ControlFlowException('Return', outcome);
            }
        }
    }

    private executeStatement(statement: StatementNode): Value | void {
        switch (statement.body.type) {
        case 'Declaration':
            return this.executeDeclaration(statement.body as DeclarationNode);
        case 'Assignment':
            return this.executeAssignment(statement.body as AssignmentNode);
        case 'Expression':
            return this.executeExpressionNode(statement.body as ExpressionNode);
        case 'ReturnStatement':
            return this.executeExpressionNode((statement.body as ReturnStatementNode).value);
        case 'IfStatement':
            return this.executeIfStatementNode(statement.body as IfStatementNode);
        case 'ImportStatement':
            throw new RuntimeException(statement.position, 'Import statements must be at the top of the file', this._code);
        }
    }

    private executeIfStatementNode = (node: IfStatementNode): void => {
        const value = this.executeExpressionNode(node.condition);
        let isConditionTrue = false;
        switch (value.type){
        case 'BooleanLiteral':
            isConditionTrue = (value as BooleanLiteralNode).value;
            break;
        case 'NothingLiteral':
            isConditionTrue = false;
            break;
        case 'FuncDeclaration':
        case 'InternalFuncDeclaration':
        case 'NumberLiteral':
        case 'TextLiteral':
        case 'Vector2Literal':
        case 'Vector3Literal':
            throw new RuntimeException(node.position, 'Invalid boolean expression', this._code);
        }

        if (isConditionTrue) {
            this.executeCodeBlock(node.trueExpression);
        } else if (node.falseExpression !== null) {
            this.executeCodeBlock(node.falseExpression);
        }

        return;
    };

    private executeDeclaration = (node: DeclarationNode) => {
        const typeOfAssignment = node.declaratorType;
        const id = node.assignmentNode.identifier.value;

        // if we have a type declared assign it else we inferred it
        const value = this.executeExpressionNode(node.assignmentNode.expression);
        let type = node.dataType?.value ?? DataTypeUtils.valueToDataType(value.type);

        if (node.isOptional) {
            if (node.dataType) {
                const optionalTypeNode = node.dataType as OptionalDataType;
                type = optionalTypeNode.internalType ?? type;
            }

            const memoryValue: OptionalMemoryValue = {
                declarationType: typeOfAssignment,
                identifier: id,
                type: 'optional',
                value,
                internalType: type
            };
            this._memory.set(id, memoryValue);
            return;
        }

        // if we have a type declared assign it else we inferred it
        this._memory.set(id, {
            declarationType: typeOfAssignment,
            identifier: id,
            type,
            value,
            internalType: null
        });
    };

    private executeAssignment = (node: AssignmentNode) => {
        const id = node.identifier.value;
        let value: Value | null = null;
        switch (node.expression.type) {
        case 'Expression':
            value = this.executeExpressionNode(node.expression as ExpressionNode);
            break;
        }

        // TODO - non function returning value on expression evaluates to null;
        if (value === null) throw new Error('Internal error on assignment');
        this._memory.update(id, value);
    };

    private executeFunctionCall = (node: FuncCallNode): Value => {
        const id = node.identifier.value;
        const memoryValue = this._memory.get(id);
        if (memoryValue.type !== 'func' && memoryValue.type !== 'internalFunc'){
            throw new RuntimeException(node.position, `Tried to call variable '${id}' as a function`, this._code);
        }

        if (memoryValue.value.type === 'NothingLiteral') {
            throw new RuntimeException(node.position, 'Tried to call \'nothing\' as a function', this._code);
        }

        const fn = (memoryValue.value as GenericFuncDeclarationNode);
        this._state.push('function');
        this._memory.createScope();

        const params = fn.parameters?.params ?? [];
        const args = node.params?.args ?? [];
        if (params.length !== args.length) {
            throw new RuntimeException(node.position, `Expecting ${params.length} arguments but got ${args.length} arguments`, this._code);
        }
        params.forEach((param, i) => {
            const arg = args[i];
            if (!arg) throw new Error('internal error, index out of bounds');
            const argResult = this.executeExpressionNode(arg);
            if (argResult === null) throw new Error('null as parameter not allowed yet');
            const dataType = DataTypeUtils.valueToDataType(argResult.type);

            // TODO - move to library
            if (dataType !== param.dataType.value) {
                throw new RuntimeException(argResult.position, 
                    `Expected argument of type ${param.dataType.value} but got ${dataType}`);
            }

            this._memory.set(param.identifier.value, {
                declarationType: 'argument',
                identifier: param.identifier.value,
                type: param.dataType.value,
                value: argResult,
                internalType: null,
            });
        });

        let returnedValue: Value = {
            type: 'NothingLiteral'
        } as NothingLiteralNode;

        if (memoryValue.type === 'internalFunc'){
            returnedValue = executeInternalFunc(fn as InternalFuncDeclarationNode, this._memory, this._system);
        } else {
            try {
                this.executeCodeBlock((fn as FuncDeclarationNode).body);
            } catch (ex:unknown) {
                if (ex instanceof ControlFlowException && ex.type === 'Return'){
                    returnedValue = ex.data;
                } else {
                    throw ex;
                }
            }
        }

        this._memory.clearScope();
        this._state.pop();
        return returnedValue;
    };

    private executeExpressionNode = (node:ExpressionNode): Value => {
        switch (node.body.type) {
        case 'FuncDeclaration':
        case 'TextLiteral':
        case 'BooleanLiteral':
        case 'NothingLiteral':
        case 'Vector2Literal':
        case 'Vector3Literal':
        case 'NumberLiteral':
            console.log(node);
            return node.body;
        case 'FuncCallNode':
            return this.executeFunctionCall(node.body as FuncCallNode);
        case 'Identifier':
            return this._memory.get((node.body as IdentifierNode).value).value;
        case 'BinaryExpression':
            return this.executeBinaryExpression(node.body as BinaryExpressionNode);
        case 'AccessorExpression':
            return this.executeAccessorExpression(node.body as AccessorExpressionNode);
        }
    };

    private executeAccessorExpression = (node: AccessorExpressionNode): Value => {
        const expressionValue = this.executeExpressionNode(node.expression);
        const expressionDataType = DataTypeUtils.valueToDataType(expressionValue.type);

        // we only have primitives yet, but once we add objects we need accessor logic
        // TODO - add object accessor
        if (node.value.type === 'FuncCallNode') {
            return StaticPrimitiveAttributes
                .executeStaticFunction(node.value.identifier, expressionValue);
        }

        throw new RuntimeException(node.position, `Attribute ${node.value} is not part ${expressionDataType}`);
    };

    private executeBinaryExpression = (node: BinaryExpressionNode): Value => {
        const rightValue = this.executeExpressionNode(node.right);
        if (rightValue === null) {
            throw new Error('Internal error binary expression must have right value');
        }

        if (
            rightValue.type === 'FuncDeclaration' ||
            rightValue.type === 'InternalFuncDeclaration'
        ) {
            throw new RuntimeException(node.position, 'Invalid binary expression', this._code);
        }

        let leftValueUnwrapped: Value = { 
            type: 'NothingLiteral',
            position: node.left.position
        };

        if (node.left.type === 'Identifier') {
            const valueFromMemory = this._memory.get(node.left.value);
            if (valueFromMemory.type === 'func' ||
                valueFromMemory.type === 'internalFunc') {
                throw new RuntimeException(node.position, 'Invalid binary expression', this._code);
            }
            leftValueUnwrapped = valueFromMemory.value;
        } else {
            leftValueUnwrapped = node.left;
        }

        // Both are boolean - binary expression
        if (leftValueUnwrapped.type === 'BooleanLiteral' && rightValue.type === 'BooleanLiteral') {
            const left = leftValueUnwrapped as BooleanLiteralNode;
            const right = rightValue as BooleanLiteralNode;
            let finalValue: boolean | null = null;

            switch (node.operator) {
            case '!=':
                finalValue = left.value !== right.value;
                break;
            case '&&':
                finalValue = left.value && right.value;
                break;
            case '==':
                finalValue = left.value === right.value;
                break;
            case '||':
                finalValue = left.value || right.value;
                break;
            }

            if (finalValue === null) {
                throw new RuntimeException(node.position, 'Unable to parse binary expression', this._code);
            }
            return {
                type: 'BooleanLiteral',
                value: finalValue,
                position: left.position
            } as BooleanLiteralNode;
        }

        if (leftValueUnwrapped.type === 'NumberLiteral' && rightValue.type === 'NumberLiteral') {
            const left = leftValueUnwrapped as NumberLiteralNode;
            const right = rightValue as NumberLiteralNode;
            let finalValue: number | boolean | null = null;

            switch (node.operator) {
            case '!=':
                finalValue = left.value !== right.value;
                break;
            case '%':
                finalValue = left.value % right.value;
                break;
            case '*':
                finalValue = left.value * right.value;
                break;
            case '-':
                finalValue = left.value - right.value;
                break;
            case '+':
                finalValue = left.value + right.value;
                break;
            case '/':
                finalValue = left.value / right.value;
                break;
            case '<':
                finalValue = left.value < right.value;
                break;
            case '<=':
                finalValue = left.value <= right.value;
                break;
            case '>=':
                finalValue = left.value >= right.value;
                break;
            case '==':
                finalValue = left.value === right.value;
                break;
            case '>':
                finalValue = left.value > right.value;
                break;
            }

            if (typeof finalValue === 'boolean') {
                return {
                    type: 'BooleanLiteral',
                    value: finalValue,
                    position: left.position
                } as BooleanLiteralNode;
            }

            if (typeof finalValue === 'number') {
                return {
                    type: 'NumberLiteral',
                    value: finalValue,
                    position: left.position
                } as NumberLiteralNode;
            }
        }

        if (leftValueUnwrapped.type === 'TextLiteral' && rightValue.type === 'TextLiteral') {
            const left = leftValueUnwrapped as TextLiteralNode;
            const right = rightValue as TextLiteralNode;
            let finalValue: string | boolean | null = null;
        
            switch (node.operator){
            case '!=':
                finalValue = left.value !== right.value;
                break;
            case '==':
                finalValue = left.value === right.value;
                break;
            case '+':
                finalValue = left.value.concat(right.value);
                break;
            }
        
            if (typeof finalValue === 'string') {
                return {
                    type: 'TextLiteral',
                    value: finalValue,
                    position: left.position
                } as TextLiteralNode;
            }

            if (typeof finalValue === 'boolean') {
                return {
                    type: 'BooleanLiteral',
                    value: finalValue,
                    position: left.position
                } as BooleanLiteralNode;
            }
        }

        if (
            leftValueUnwrapped.type !== rightValue.type &&
            node.operator === '!=' ||
            node.operator === '=='
        ){
            return {
                type: 'BooleanLiteral',
                value: node.operator === '!=',
                position: node.position
            } as BooleanLiteralNode;
        }

        // TODO - implement vectors
        throw new RuntimeException(node.left.position, 'Unable to parse binary expression', this._code);
    };
}